import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertOptions } from "src/Settings.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { Document, Font, Image, PDFDocument, PDFPage } from "mupdf";
import { changeExt } from "src/common/index.ts";

// its own format, so that picking it is a request to split rather than a PDF to PDF no-op
const PDF_PAGES = new FormatDefinition(
  "PDF pages (one file per page)",
  "pdf-pages",
  "pdf",
  "application/pdf",
  Category.DOCUMENT,
);

// its own format, so that picking it is a request to put every image on a page of one PDF
const PDF_FROM_IMAGES = new FormatDefinition(
  "PDF with one image per page",
  "pdf-from-images",
  "pdf",
  "application/pdf",
  Category.DOCUMENT,
);

/**
 * Reads a page selection such as "2-5,8" or "3-1".
 * @returns Zero-based page indexes in the order they were written.
 */
export function parsePageRange(text: string, pageCount: number): number[] {
  const pages: number[] = [];
  for (const part of text.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error(`"${part.trim()}" is not a page or a range like 2-5.`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? first);
    for (const page of [first, last]) {
      if (page < 1 || page > pageCount) {
        throw new Error(`Page ${page} does not exist: the PDF has ${pageCount} pages.`);
      }
    }
    const step = first <= last ? 1 : -1;
    for (let page = first; page !== last + step; page += step) pages.push(page - 1);
  }
  return pages;
}

function openPdf(file: FileData, password?: string): PDFDocument {
  const doc = Document.openDocument(file.bytes, "application/pdf").asPDF();
  if (!doc) throw new Error(`${file.name} is not a PDF.`);
  if (doc.needsPassword()) {
    if (!password) {
      throw new Error(`${file.name} is password protected. Enter its password in the settings.`);
    }
    if (!doc.authenticatePassword(password)) {
      throw new Error(`The password for ${file.name} is wrong.`);
    }
  }
  return doc;
}

/**
 * Opens a PDF and applies the page selection and the rotation.
 * The document is changed in place, not copied page by page into a new one, which would
 * lose its bookmarks, form fields and metadata.
 */
function openEdited(file: FileData, settings: ConvertOptions): PDFDocument {
  const doc = openPdf(file, settings.password);

  if (settings.pages) doc.rearrangePages(parsePageRange(settings.pages, doc.countPages()));
  if (settings.rotate) {
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.findPage(i);
      // a page without its own rotation takes that of the page tree above it
      const current = page.getInheritable("Rotate");
      const degrees = current.isNumber() ? current.asNumber() : 0;
      page.put("Rotate", (degrees + Number(settings.rotate)) % 360);
    }
  }
  return doc;
}

/**
 * Re-encodes the plain photos of a PDF as JPEG, where that makes them smaller than they are
 * in the file now.
 *
 * shortcut: skips images with a mask, a decode array, or a colour space other than 8-bit grey
 * or RGB, and never lowers the resolution. Handle those when scans with CMYK or transparent
 * images turn out to be common.
 */
function recompressImages(doc: PDFDocument, quality: number) {
  for (let number = 1; number < doc.countObjects(); number++) {
    // only the reference knows whether the object has a stream; the resolved dictionary says no
    const ref = doc.newIndirect(number);
    if (!ref.isStream() || ref.get("Subtype").toString() !== "/Image") continue;
    if (["SMask", "Mask", "ImageMask", "Decode"].some((key) => !ref.get(key).isNull())) continue;

    const image = doc.loadImage(ref);
    const space = image.getColorSpace();
    if (image.getBitsPerComponent() !== 8 || !space || !(space.isGray() || space.isRGB())) continue;

    const pixmap = image.toPixmap();
    const jpeg = pixmap.asJPEG(quality);
    pixmap.destroy();
    if (jpeg.length >= ref.readRawStream().getLength()) continue;

    // the colour space entry stays: the JPEG has the same channels, and it may name a profile
    ref.writeRawStream(jpeg);
    ref.put("Filter", doc.newName("DCTDecode"));
    ref.delete("DecodeParms");
  }
}

/** Text as a PDF string in the font's Latin encoding. */
function pdfString(text: string) {
  // shortcut: characters outside Latin-1 print as "?". Embed a Unicode font if that matters.
  const latin = text.replace(/[^\x20-\xff]/g, "?").replace(/[\\()]/g, "\\$&");
  return `(${latin})`;
}

/**
 * Prints page numbers and a watermark on every page, over what is there.
 *
 * shortcut: positions use the unrotated page, so on a page with /Rotate the number sits on
 * a side edge. Turn the stamp with the page once rotated scans need numbering.
 */
function stamp(doc: PDFDocument, { pageNumbers, watermark }: ConvertOptions) {
  if (!pageNumbers && !watermark) return;
  const font = doc.addSimpleFont(new Font("Helvetica"));
  const faded = doc.newDictionary();
  faded.put("Type", doc.newName("ExtGState"));
  faded.put("ca", 0.3);
  const count = doc.countPages();

  for (let i = 0; i < count; i++) {
    const page = doc.findPage(i);
    // added to the resources the page already uses, wherever in the page tree they are,
    // because a new dictionary on the page would hide its own fonts and images
    let resources = page.getInheritable("Resources");
    if (resources.isNull()) {
      resources = doc.newDictionary();
      page.put("Resources", resources);
    }
    for (const [kind, name, value] of [
      ["Font", "StampFont", font],
      ["ExtGState", "StampFade", faded],
    ] as const) {
      if (resources.get(kind).isNull()) resources.put(kind, doc.newDictionary());
      resources.get(kind).put(name, value);
    }

    const cropBox = page.getInheritable("CropBox");
    const box = cropBox.isNull() ? page.getInheritable("MediaBox") : cropBox;
    const [ax, ay, bx, by] = [0, 1, 2, 3].map((n) => box.get(n).asNumber());
    const [x0, y0, x1, y1] = [
      Math.min(ax, bx),
      Math.min(ay, by),
      Math.max(ax, bx),
      Math.max(ay, by),
    ];
    const [width, height] = [x1 - x0, y1 - y0];

    let ops = "";
    if (watermark) {
      // Helvetica averages about half an em per character
      const size = Math.min(96, (Math.hypot(width, height) * 0.7) / (0.5 * watermark.length));
      const angle = Math.atan2(height, width);
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)].map((n) => n.toFixed(4));
      const [cx, cy] = [x0 + width / 2, y0 + height / 2];
      ops += `q /StampFade gs 0.5 g BT /StampFont ${size.toFixed(1)} Tf `;
      ops += `${cos} ${sin} -${sin} ${cos} ${cx} ${cy} Tm `;
      ops += `${((-size * 0.5 * watermark.length) / 2).toFixed(1)} ${(-size / 3).toFixed(1)} Td `;
      ops += `${pdfString(watermark)} Tj ET Q\n`;
    }
    if (pageNumbers) {
      const number = String(i + 1);
      // Helvetica's digits are all 0.556 em wide
      const x = x0 + width / 2 - (number.length * 0.556 * 10) / 2;
      ops += `q 0 g BT /StampFont 10 Tf ${x.toFixed(1)} ${y0 + 20} Td (${number}) Tj ET Q\n`;
    }

    // the page's own content goes between q and Q, so that a transformation it leaves behind
    // doesn't move the stamp
    const contents = doc.newArray();
    contents.push(doc.addStream("q\n", {}));
    const old = page.get("Contents");
    if (old.isArray()) old.forEach((part) => contents.push(part));
    else if (!old.isNull()) contents.push(old);
    contents.push(doc.addStream(`Q\n${ops}`, {}));
    page.put("Contents", contents);
  }
}

/**
 * What a "Redact text" setting asks to find: one `/regular expression/flags`, or words and
 * phrases separated by commas.
 */
export function redactionTargets(setting: string, pageText: string): string[] {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(setting.trim());
  if (!regex)
    return setting
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
  const flags = regex[2].includes("g") ? regex[2] : regex[2] + "g";
  let pattern: RegExp;
  try {
    pattern = new RegExp(regex[1], flags);
  } catch {
    throw new Error(`"${setting}" is not a regular expression this browser can read.`);
  }
  return [...new Set([...pageText.matchAll(pattern)].map((m) => m[0]).filter((m) => m.trim()))];
}

/**
 * Blacks out every place the text occurs and removes what is under it from the file: the
 * text itself, and the pixels of images under it. A box drawn over text would leave the text
 * in the file for anyone to copy; this doesn't.
 * @returns How many places were blacked out.
 */
function redact(doc: PDFDocument, setting: string): number {
  let count = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const text = page.toStructuredText("preserve-whitespace").asText();
    let marked = 0;
    for (const target of redactionTargets(setting, text)) {
      for (const quads of page.search(target, "")) {
        const annot = page.createAnnotation("Redact");
        annot.setQuadPoints(quads);
        marked++;
      }
    }
    if (marked) {
      page.applyRedactions(
        true,
        PDFPage.REDACT_IMAGE_PIXELS,
        PDFPage.REDACT_LINE_ART_NONE,
        PDFPage.REDACT_TEXT_REMOVE,
      );
      count += marked;
    }
  }
  return count;
}

/** The PNG of a signature: the drawn one as it is, a typed one written in a handwriting font. */
async function signaturePng(signature: string): Promise<Uint8Array> {
  const drawn = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(signature);
  if (drawn) return Uint8Array.from(atob(drawn[1]), (c) => c.charCodeAt(0));
  const font =
    'italic 72px "Snell Roundhand", "Segoe Script", "Brush Script MT", "Apple Chancery", cursive';
  const measure = new OffscreenCanvas(1, 1).getContext("2d")!;
  measure.font = font;
  const width = Math.ceil(measure.measureText(signature).width) + 40;
  const canvas = new OffscreenCanvas(Math.min(width, 4000), 120);
  const c = canvas.getContext("2d")!;
  c.font = font;
  c.fillStyle = "#14286e";
  c.textBaseline = "middle";
  c.fillText(signature, 20, 62);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

/** Puts the signature on one page, in a corner, over what is there. */
async function sign(
  doc: PDFDocument,
  { signature, signaturePage, signatureCorner }: ConvertOptions,
) {
  if (!signature) return;
  const count = doc.countPages();
  const index = Math.min(count, signaturePage ?? count) - 1;
  const image = new Image(await signaturePng(signature));
  const page = doc.findPage(index);
  let resources = page.getInheritable("Resources");
  if (resources.isNull()) {
    resources = doc.newDictionary();
    page.put("Resources", resources);
  }
  if (resources.get("XObject").isNull()) resources.put("XObject", doc.newDictionary());
  resources.get("XObject").put("StampSignature", doc.addImage(image));

  const cropBox = page.getInheritable("CropBox");
  const box = cropBox.isNull() ? page.getInheritable("MediaBox") : cropBox;
  const [ax, ay, bx, by] = [0, 1, 2, 3].map((n) => box.get(n).asNumber());
  const [x0, y0, x1, y1] = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  // at most a third of the page wide and 60 points high, keeping its proportions
  const ratio = image.getHeight() / image.getWidth();
  let w = Math.min((x1 - x0) / 3, 200);
  let h = w * ratio;
  if (h > 60) [w, h] = [60 / ratio, 60];
  const margin = 36;
  const corner = signatureCorner ?? "bottom right";
  const x = corner.endsWith("left") ? x0 + margin : x1 - margin - w;
  const y = corner.startsWith("top") ? y1 - margin - h : y0 + margin;

  const contents = doc.newArray();
  contents.push(doc.addStream("q\n", {}));
  const old = page.get("Contents");
  if (old.isArray()) old.forEach((part) => contents.push(part));
  else if (!old.isNull()) contents.push(old);
  contents.push(
    doc.addStream(
      `Q\nq ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /StampSignature Do Q\n`,
      {},
    ),
  );
  page.put("Contents", contents);
}

/** Save options that lock the PDF with `protect`, or unlock it when it was opened with a password. */
function lockOptions({ password, protect }: ConvertOptions) {
  if (protect) return `,encrypt=aes-256,user-password=${protect},owner-password=${protect}`;
  return password ? ",decrypt" : "";
}

// "garbage" drops what is no longer referenced, such as the pages left out and replaced images
const COMPRESSED = "garbage=deduplicate,compress,compress-images,compress-fonts";

function save(doc: PDFDocument, options: string) {
  const bytes = new Uint8Array(doc.saveToBuffer(options).asUint8Array());
  doc.destroy();
  return bytes;
}

/** Makes a PDF smaller, and applies the page selection and rotation from the output settings. */
export class compressPdfHandler implements FormatHandler {
  public readonly name = "compressPdf";
  // a single format means no edges in the conversion graph, so this only runs for PDF to PDF
  // (see `compressorsFor`)
  public supportedFormats = [
    Formats.PDF.builder("pdf")
      .options({
        quality: true,
        pages: true,
        rotate: true,
        password: true,
        protect: true,
        pageNumbers: true,
        watermark: true,
        redact: true,
        signature: true,
        signaturePage: true,
        signatureCorner: true,
      })
      .fromTo(),
  ];
  public ready = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    _outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const settings = ctx?.options ?? {};
    const outputs: FileData[] = [];
    for (const file of inputFiles) {
      ctx?.throwIfAborted();
      let doc = openEdited(file, settings);
      if (settings.redact) {
        const count = redact(doc, settings.redact);
        ctx?.log(
          `${file.name}: ${count ? `blacked out ${count} places` : "the text to redact was not found"}.`,
        );
      }
      stamp(doc, settings);
      await sign(doc, settings);
      doc.subsetFonts();
      if (settings.quality) {
        // on the saved result, so that a JPEG is compared with the image as losslessly
        // compressed and not with pixels the file happened to store raw.
        // Saved without a password in between, so that it opens again without one.
        const decrypt = settings.password || settings.protect ? ",decrypt" : "";
        doc = openPdf({ name: file.name, bytes: save(doc, COMPRESSED + decrypt) });
        recompressImages(doc, settings.quality);
      }
      outputs.push({ name: file.name, bytes: save(doc, COMPRESSED + lockOptions(settings)) });
    }
    return outputs;
  }
}

// their own formats, so that the Tools row can offer them as tools
const PDF_REDACTED = new FormatDefinition(
  "PDF, redacted",
  "pdf-redacted",
  "pdf",
  "application/pdf",
  Category.DOCUMENT,
);
const PDF_SIGNED = new FormatDefinition(
  "PDF, signed",
  "pdf-signed",
  "pdf",
  "application/pdf",
  Category.DOCUMENT,
);

/** Redact and Sign as tools of their own: the same work as a PDF to PDF with those settings. */
export class pdfEditHandler implements FormatHandler {
  public readonly name = "pdfEdit";
  public supportedFormats = [
    Formats.PDF.builder("pdf").from(),
    PDF_REDACTED.builder("pdf")
      .lossless()
      .options({ redact: true, password: true, protect: true })
      .to(),
    PDF_SIGNED.builder("pdf")
      .lossless()
      .options({
        signature: true,
        signaturePage: true,
        signatureCorner: true,
        password: true,
        protect: true,
      })
      .to(),
  ];
  public ready = false;
  readonly #inner = new compressPdfHandler();

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const options = ctx?.options ?? {};
    if (outputFormat.format === "pdf-redacted" && !options.redact) {
      throw new Error("Enter the text to redact in Settings first.");
    }
    if (outputFormat.format === "pdf-signed" && !options.signature) {
      throw new Error("Draw or type the signature in Settings first.");
    }
    const suffix = outputFormat.format === "pdf-redacted" ? "-redacted" : "-signed";
    const outputs = await this.#inner.doConvert(inputFiles, inputFormat, outputFormat, ctx);
    return outputs.map((file) => ({ ...file, name: changeExt(file.name, "pdf", suffix) }));
  }
}

/** Writes every page of a PDF, or the selected ones, as a PDF of its own. */
export class splitPdfHandler implements FormatHandler {
  public readonly name = "splitPdf";
  public supportedFormats = [
    Formats.PDF.builder("pdf").from(),
    PDF_PAGES.builder("pdf").lossless().options({ pages: true, rotate: true, password: true }).to(),
  ];
  public ready = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    _outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];
    for (const file of inputFiles) {
      ctx?.throwIfAborted();
      const { pages, rotate, password } = ctx?.options ?? {};
      const source = openEdited(file, { rotate, password });
      const count = source.countPages();
      const digits = String(count).length;
      // the selection is applied here and not by `openEdited`, so that each file can be named
      // after the page it was in the original
      const kept = pages
        ? parsePageRange(pages, count)
        : Array.from({ length: count }, (_, i) => i);
      for (const i of kept) {
        const page = new PDFDocument();
        page.graftPage(-1, source, i);
        const suffix = `-page-${String(i + 1).padStart(digits, "0")}`;
        outputFiles.push({
          name: changeExt(file.name, "pdf", suffix),
          bytes: save(page, "compress"),
        });
      }
      source.destroy();
    }
    return outputFiles;
  }
}

/** Puts each image on a page of its own in one PDF, the size of the image. */
export class imagesToPdfHandler implements FormatHandler {
  public readonly name = "imagesToPdf";
  public supportedFormats = [
    Formats.PNG.builder("png").from(),
    Formats.JPEG.builder("jpeg").from(),
    PDF_FROM_IMAGES.builder("pdf").lossless().to(),
  ];
  public ready = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    _outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const doc = new PDFDocument();
    for (const file of inputFiles) {
      ctx?.throwIfAborted();
      // mupdf keeps a JPEG as it is, without decoding and encoding it again
      const image = new Image(file.bytes);
      // a point is 1/72 inch, and an image without a resolution counts as 96 dpi
      const [width, height] = [
        (image.getWidth() * 72) / (image.getXResolution() || 96),
        (image.getHeight() * 72) / (image.getYResolution() || 96),
      ];
      const page = doc.addPage(
        [0, 0, width, height],
        0,
        { XObject: { Image: doc.addImage(image) } },
        `q ${width} 0 0 ${height} 0 0 cm /Image Do Q`,
      );
      doc.insertPage(-1, page);
    }
    return [{ name: changeExt(inputFiles[0].name, "pdf"), bytes: save(doc, "compress") }];
  }
}
