import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { changeExt, decode, encode, stripExt } from "src/common/index.ts";
import { escapeHtml, renderMarkdown, stripFrontMatter } from "src/common/markdown.ts";
import { isLook, lookCss, type LookName } from "src/common/looks.ts";

export const SLIDES_HTML = new FormatDefinition(
  "Slide deck (HTML, works offline)",
  "slides",
  "html",
  "text/html",
  [Category.PRESENTATION, Category.DOCUMENT],
);
export const SLIDES_PDF = new FormatDefinition(
  "Slide deck (PDF, a page per slide)",
  "slides-pdf",
  "pdf",
  "application/pdf",
  [Category.PRESENTATION, Category.DOCUMENT],
);

/**
 * A note cut into slides. A line of `---` on its own starts a new slide; a note without one
 * gets a slide per `#` or `##` heading. Lines from `Note:` or `???` to the end of a slide are
 * speaker notes, left off the slide.
 */
export function splitSlides(source: string): { body: string; notes: string }[] {
  const text = stripFrontMatter(source.replace(/\r\n?/g, "\n"));
  const lines = text.split("\n");
  let fenced = false;
  const isRule = (line: string) => !fenced && /^---\s*$/.test(line);
  const hasRules = lines.some((line) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    return isRule(line);
  });
  fenced = false;

  const slides: string[][] = [[]];
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const newSlide = hasRules ? isRule(line) : !fenced && /^#{1,2}\s/.test(line);
    if (newSlide && slides.at(-1)!.some((l) => l.trim())) slides.push([]);
    if (!(hasRules && isRule(line))) slides.at(-1)!.push(line);
  }
  return slides
    .map((slide) => {
      const at = slide.findIndex((line) => /^(Note:|\?\?\?)/.test(line.trim()));
      const body = (at < 0 ? slide : slide.slice(0, at)).join("\n").trim();
      const notes =
        at < 0
          ? ""
          : slide
              .slice(at)
              .join("\n")
              .replace(/^(Note:|\?\?\?)\s*/, "")
              .trim();
      return { body, notes };
    })
    .filter((slide) => slide.body);
}

const DECK_SCRIPT = `
const slides = [...document.querySelectorAll(".slide")];
const counter = document.querySelector(".counter");
let current = 0;
function show(n) {
  current = Math.max(0, Math.min(slides.length - 1, n));
  slides.forEach((s, i) => { s.hidden = i !== current; s.setAttribute("aria-hidden", String(i !== current)); });
  counter.textContent = (current + 1) + " / " + slides.length;
  history.replaceState(null, "", "#" + (current + 1));
}
addEventListener("keydown", (e) => {
  if (e.target.closest && e.target.closest("input, textarea")) return;
  if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); show(current + 1); }
  else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); show(current - 1); }
  else if (e.key === "Home") show(0);
  else if (e.key === "End") show(slides.length - 1);
  else if (e.key === "f" || e.key === "F") { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
});
document.querySelector(".prev").onclick = () => show(current - 1);
document.querySelector(".next").onclick = () => show(current + 1);
show((parseInt(location.hash.slice(1), 10) || 1) - 1);
`;

const DECK_CSS = `
.deck { display: grid; place-items: center; min-height: 100vh; padding: 2vmin; }
.slide { width: min(96vw, calc(94vh * 16 / 9)); aspect-ratio: 16 / 9; padding: 5% 7%; overflow: auto;
  font-size: min(2.6vw, 4.6vh); display: flex; flex-direction: column; justify-content: center; }
.slide h1 { font-size: 2.2em; margin: 0 0 0.4em; line-height: 1.1; }
.slide h2 { font-size: 1.6em; margin: 0 0 0.5em; line-height: 1.15; }
.slide h3 { font-size: 1.2em; margin: 0.4em 0; }
.slide ul, .slide ol { margin: 0.2em 0; padding-left: 1.2em; }
.slide li { margin: 0.25em 0; }
.slide li.task { list-style: none; margin-left: -1.2em; }
.slide img { max-height: 50vh; object-fit: contain; }
.bar { position: fixed; right: 1rem; bottom: 1rem; display: flex; gap: 0.5rem; align-items: center; opacity: 0.55; }
.bar:hover, .bar:focus-within { opacity: 1; }
.counter { min-width: 4em; text-align: center; }
@media print {
  .bar { display: none; }
  .deck { display: block; padding: 0; }
  .slide { display: flex !important; width: 100%; height: 100vh; page-break-after: always; break-after: page; font-size: 20pt; }
  @page { size: 16in 9in; margin: 0; }
}
`;

/** The whole deck as one HTML file: no outside files, no network. */
export function deckHtml(title: string, slides: { body: string }[], look: LookName): string {
  const sections = slides
    .map(
      (slide, i) =>
        `<section class="slide panel" aria-roledescription="slide" aria-label="${i + 1} of ${slides.length}">\n${renderMarkdown(slide.body)}\n</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title>
<style>${lookCss(look)}${DECK_CSS}</style>
</head>
<body class="surface">
<main class="deck">
${sections}
</main>
<nav class="bar" aria-label="Slides"><button class="prev" aria-label="Previous slide">←</button><span class="counter"></span><button class="next" aria-label="Next slide">→</button></nav>
<script>${DECK_SCRIPT}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------- PDF

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; text: string; depth: number; box?: boolean; checked?: boolean }
  | { kind: "text"; text: string }
  | { kind: "code"; text: string };

/** Markdown reduced to what a PDF page shows: headings, list items, paragraphs and code. */
export function slideBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (/^(```|~~~)/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^(```|~~~)/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      blocks.push({ kind: "heading", level: m[1].length, text: plain(m[2]) });
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(\[(.)\]\s+)?(.*)$/.exec(line))) {
      blocks.push({
        kind: "item",
        depth: Math.floor(m[1].length / 2),
        text: plain(m[5]),
        box: m[3] !== undefined,
        checked: m[4]?.toLowerCase() === "x",
      });
    } else if (line.trim() && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      const last = blocks.at(-1);
      if (last?.kind === "text" && lines[i - 1]?.trim()) last.text += " " + plain(line.trim());
      else blocks.push({ kind: "text", text: plain(line.trim()) });
    }
  }
  return blocks;
}

/** Inline Markdown taken off, for the PDF, which has no styling inside a line. */
const plain = (text: string) =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|==|`)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S.*?)[*_](?=\W|$)/g, "$1$2")
    // Helvetica in a PDF has no emoji and no characters outside Latin-1
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[^ -ÿ–—‘’“”•…€]/g, "?");

const PDF_COLOURS: Record<
  LookName,
  { page: string[]; text: string; heading: string; panel?: string }
> = {
  plain: { page: ["#ffffff"], text: "#1d1d22", heading: "#101014" },
  Win98: { page: ["#008080"], text: "#000000", heading: "#000080", panel: "#c0c0c0" },
  "liquid glass": {
    page: ["#8ec5fc", "#e0c3fc"],
    text: "#101018",
    heading: "#101018",
    panel: "#ffffff",
  },
  Xiao: { page: ["#f3ecdf"], text: "#2a1d17", heading: "#b3261e" },
};

export async function deckPdf(slides: { body: string }[], look: LookName): Promise<Uint8Array> {
  const [{ default: PDFDocument }, helvetica, bold, oblique, courier] = await Promise.all([
    import("pdfkit"),
    import("pdfkit/standard-fonts/Helvetica"),
    import("pdfkit/standard-fonts/HelveticaBold"),
    import("pdfkit/standard-fonts/HelveticaOblique"),
    import("pdfkit/standard-fonts/Courier"),
  ]);
  const { registerStdFonts } = await import("pdfkit");
  registerStdFonts(helvetica.default, bold.default, oblique.default, courier.default);

  const W = 960;
  const H = 540;
  const colours = PDF_COLOURS[look];
  const doc = new PDFDocument({ size: [W, H], autoFirstPage: false, margin: 0 });
  const done = new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    doc.on("end", () => new Blob(chunks as BlobPart[]).bytes().then(resolve, reject));
    doc.on("error", reject);
  });

  for (const slide of slides) {
    doc.addPage({ size: [W, H], margin: 0 });
    if (colours.page.length > 1) {
      const g = doc.linearGradient(0, 0, W, H);
      g.stop(0, colours.page[0]).stop(1, colours.page[1]);
      doc.rect(0, 0, W, H).fill(g);
    } else doc.rect(0, 0, W, H).fill(colours.page[0]);
    let x = 70;
    let width = W - 140;
    if (colours.panel) {
      if (look === "Win98") {
        doc.rect(30, 30, W - 60, H - 60).fill(colours.panel);
        doc.rect(34, 34, W - 68, 22).fill("#000080");
      } else {
        doc
          .roundedRect(30, 30, W - 60, H - 60, 24)
          .fillOpacity(0.45)
          .fill(colours.panel)
          .fillOpacity(1);
      }
      x = 70;
      width = W - 140;
    }
    let y = 80;
    for (const block of slideBlocks(slide.body)) {
      if (y > H - 60) break;
      if (block.kind === "heading") {
        const size = block.level === 1 ? 40 : block.level === 2 ? 32 : 24;
        doc.font("Helvetica-Bold").fontSize(size).fillColor(colours.heading);
        doc.text(block.text, x, y, { width });
        y = doc.y + size * 0.35;
      } else if (block.kind === "item") {
        const indent = x + 24 + block.depth * 28;
        doc.font("Helvetica").fontSize(22).fillColor(colours.text);
        const mark = block.box ? (block.checked ? "[x]" : "[ ]") : "•";
        doc.text(mark, indent - 24, y, { width: 24 });
        doc.text(block.text, indent + (block.box ? 14 : 0), y, {
          width: width - (indent - x) - 14,
        });
        y = doc.y + 6;
      } else if (block.kind === "code") {
        doc.font("Courier").fontSize(15).fillColor(colours.text);
        doc.text(block.text, x + 12, y, { width: width - 24 });
        y = doc.y + 12;
      } else {
        doc.font("Helvetica").fontSize(22).fillColor(colours.text);
        doc.text(block.text, x, y, { width });
        y = doc.y + 10;
      }
    }
  }
  doc.end();
  return done;
}

/** Presents a note as a slide deck: an HTML page that works offline, or a PDF. */
class slidesHandler implements FormatHandler {
  public readonly name = "slides";
  public supportedFormats = [
    Formats.MD.builder("md").from(),
    Formats.TEXT.builder("text").from(),
    SLIDES_HTML.builder("html").options({ look: true }).to(),
    SLIDES_PDF.builder("pdf").options({ look: true }).to(),
  ];
  public ready = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const chosen = ctx?.options.look;
    const look: LookName = isLook(chosen) ? chosen : "plain";
    const outputs: FileData[] = [];
    for (const [i, file] of inputFiles.entries()) {
      ctx?.progress(`Making slides of ${file.name}...`, i / inputFiles.length);
      const text = decode(file.bytes);
      const slides = splitSlides(text);
      if (!slides.length)
        throw new Error(`${file.name} is empty: there is nothing to put on a slide.`);
      const title = /^#\s+(.+)$/m.exec(stripFrontMatter(text))?.[1].trim() ?? stripExt(file.name);
      if (outputFormat.internal === "pdf") {
        outputs.push({
          name: changeExt(file.name, "pdf", "-slides"),
          bytes: await deckPdf(slides, look),
        });
      } else {
        outputs.push({
          name: changeExt(file.name, "html", "-slides"),
          bytes: encode(deckHtml(title.replace(/[*_`~=]/g, ""), slides, look)),
        });
      }
    }
    return outputs;
  }
}

export default slidesHandler;
