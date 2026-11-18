import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { canvasToBlob, createCanvas } from "src/common/canvas.ts";
import { changeExt, encode, stripExt } from "src/common/index.ts";
import { imageToText, rgbaToGrayscale } from "built/image-to-txt/src/convert.ts";
import { halftone, type Pixels } from "./halftone/engine.ts";
import JSZip from "jszip";

// their own formats, so that picking one is a request for the tool rather than a plain PNG
const FAVICON = new FormatDefinition(
  "Favicon set (ICO, PNGs and manifest)",
  "favicon",
  "zip",
  "application/zip",
  Category.ARCHIVE,
);
const COLLAGE = new FormatDefinition(
  "Collage (all selected images in one)",
  "collage",
  "png",
  "image/png",
  Category.IMAGE,
);
const FRAMED = new FormatDefinition(
  "Screenshot, framed",
  "framed",
  "png",
  "image/png",
  Category.IMAGE,
);
const HALFTONE = new FormatDefinition(
  "Halftone print",
  "halftone",
  "png",
  "image/png",
  Category.IMAGE,
);
const ASCII_HTML = new FormatDefinition("ASCII art in colour", "ascii-html", "html", "text/html", [
  Category.TEXT,
  Category.DOCUMENT,
]);

/** What these tools read: the pictures the browser decodes itself. */
const PICTURES = [
  Formats.PNG.builder("png").from(),
  Formats.JPEG.builder("jpeg").from(),
  Formats.WEBP.builder("webp").from(),
];

async function decode(file: FileData) {
  return createImageBitmap(new Blob([file.bytes as BlobPart]));
}

/** Draws `image` as large as fits in the box, centred, keeping its aspect ratio. */
function drawContained(
  ctx: OffscreenCanvasRenderingContext2D,
  image: ImageBitmap,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.min(width / image.width, height / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

/**
 * Packs PNGs into one ICO. Every entry keeps its PNG as it is, which all browsers and Windows
 * since Vista read.
 */
export function writeIco(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const header = 6 + 16 * images.length;
  const total = header + images.reduce((sum, { png }) => sum + png.length, 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);
  let offset = header;
  for (const [i, { size, png }] of images.entries()) {
    const entry = 6 + 16 * i;
    // a side of 256 is written as 0
    view.setUint8(entry, size % 256);
    view.setUint8(entry + 1, size % 256);
    view.setUint16(entry + 4, 1, true); // colour planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, png.length, true);
    view.setUint32(entry + 12, offset, true);
    bytes.set(png, offset);
    offset += png.length;
  }
  return bytes;
}

/** The files a site needs for its icon, from one square picture of each size. */
export async function faviconFiles(
  square: (size: number) => Promise<Uint8Array>,
  name: string,
): Promise<Record<string, Uint8Array | string>> {
  const png = async (size: number) => ({ size, png: await square(size) });
  const [s16, s32, s48, s180, s192, s512] = await Promise.all([16, 32, 48, 180, 192, 512].map(png));
  const manifest = {
    name,
    short_name: name,
    icons: [
      { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    theme_color: "#ffffff",
    background_color: "#ffffff",
    display: "standalone",
  };
  const html = [
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    "",
  ].join("\n");
  return {
    "favicon.ico": writeIco([s16, s32, s48]),
    "favicon-16x16.png": s16.png,
    "favicon-32x32.png": s32.png,
    "apple-touch-icon.png": s180.png,
    "android-chrome-192x192.png": s192.png,
    "android-chrome-512x512.png": s512.png,
    "site.webmanifest": JSON.stringify(manifest, null, 2) + "\n",
    "favicon.html": html,
  };
}

/** Makes the icons a site needs from one picture, in one zip. */
export class faviconHandler implements FormatHandler {
  public readonly name = "favicon";
  public supportedFormats = [...PICTURES, FAVICON.builder("zip").lossless().to()];
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
    for (const [i, file] of inputFiles.entries()) {
      ctx?.throwIfAborted();
      ctx?.progress(`Drawing icons of ${file.name}...`, i / inputFiles.length);
      const image = await decode(file);
      // a picture that isn't square sits in the middle, on transparency
      const square = async (size: number) => {
        const bundle = createCanvas(size, size);
        bundle.ctx.imageSmoothingQuality = "high";
        drawContained(bundle.ctx, image, 0, 0, size, size);
        return canvasToBlob(bundle, "image/png");
      };
      const files = await faviconFiles(square, stripExt(file.name));
      image.close();
      const zip = new JSZip();
      for (const [path, content] of Object.entries(files)) zip.file(path, content);
      outputFiles.push({
        name: changeExt(file.name, "zip", "-favicon"),
        bytes: await zip.generateAsync({ type: "uint8array" }),
      });
    }
    return outputFiles;
  }
}

/** Gap between and around the pictures of a collage, in pixels. */
const GAP = 8;
/** Longest side of a collage, which keeps it within what a canvas can hold everywhere. */
const COLLAGE_MAX = 4096;

/** Lays all selected pictures out in one grid, in the order of the file bar. */
export class collageHandler implements FormatHandler {
  public readonly name = "collage";
  public supportedFormats = [...PICTURES, COLLAGE.builder("png").lossless().to()];
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
    ctx?.progress("Reading the pictures...", 0);
    const images = await Promise.all(inputFiles.map(decode));
    const columns = Math.ceil(Math.sqrt(images.length));
    const rows = Math.ceil(images.length / columns);
    // every cell is as large as the largest picture, then all of it shrinks to fit the limit
    let cellWidth = Math.max(...images.map((image) => image.width));
    let cellHeight = Math.max(...images.map((image) => image.height));
    const scale = Math.min(
      1,
      COLLAGE_MAX / (columns * cellWidth + (columns + 1) * GAP),
      COLLAGE_MAX / (rows * cellHeight + (rows + 1) * GAP),
    );
    cellWidth = Math.max(1, Math.floor(cellWidth * scale));
    cellHeight = Math.max(1, Math.floor(cellHeight * scale));

    const bundle = createCanvas(
      columns * cellWidth + (columns + 1) * GAP,
      rows * cellHeight + (rows + 1) * GAP,
    );
    bundle.ctx.fillStyle = "white";
    bundle.ctx.fillRect(0, 0, bundle.canvas.width, bundle.canvas.height);
    bundle.ctx.imageSmoothingQuality = "high";
    for (const [i, image] of images.entries()) {
      const x = GAP + (i % columns) * (cellWidth + GAP);
      const y = GAP + Math.floor(i / columns) * (cellHeight + GAP);
      drawContained(bundle.ctx, image, x, y, cellWidth, cellHeight);
      image.close();
    }
    ctx?.progress("Encoding the collage...", 0.9);
    return [
      {
        name: changeExt(inputFiles[0].name, "png", "-collage"),
        bytes: await canvasToBlob(bundle, "image/png"),
      },
    ];
  }
}

/** The backgrounds a framed screenshot can sit on: two colours of a diagonal gradient. */
export const FRAME_BACKGROUNDS: Record<string, [string, string] | null> = {
  sky: ["#8ec5fc", "#e0c3fc"],
  sunset: ["#ff9a8b", "#ffd36e"],
  mint: ["#84fab0", "#8fd3f4"],
  graphite: ["#232526", "#5b6066"],
  white: ["#ffffff", "#ffffff"],
  transparent: null,
};

/** Sizes of the window around a framed screenshot, in pixels, for a picture of this size. */
export function frameLayout(width: number, height: number, style: string) {
  const longest = Math.max(width, height);
  // the window's parts grow with the picture, so they look the same at any size
  const u = Math.max(1, Math.round(longest / 900));
  const pad = Math.round(longest * 0.08);
  const bar = style === "card" ? 0 : style === "Win98 window" ? 20 * u : 28 * u;
  const border = style === "Win98 window" ? 4 * u : 0;
  const windowWidth = width + 2 * border;
  const windowHeight = height + bar + 2 * border + (style === "Win98 window" ? 2 * u : 0);
  return {
    u,
    pad,
    bar,
    border,
    windowWidth,
    windowHeight,
    width: windowWidth + 2 * pad,
    height: windowHeight + 2 * pad,
  };
}

type Ctx = OffscreenCanvasRenderingContext2D;

/** A raised or sunken Windows 98 edge: light on the top left, dark on the bottom right. */
function bevel(c: Ctx, x: number, y: number, w: number, h: number, u: number, sunken = false) {
  const [light, dark] = sunken ? ["#808080", "#ffffff"] : ["#ffffff", "#404040"];
  c.fillStyle = dark;
  c.fillRect(x, y, w, h);
  c.fillStyle = light;
  c.fillRect(x, y, w - u, h - u);
  c.fillStyle = sunken ? "#ffffff" : "#808080";
  c.fillRect(x + u, y + u, w - 2 * u, h - 2 * u);
  c.fillStyle = sunken ? "#808080" : "#dfdfdf";
  c.fillRect(x + u, y + u, w - 3 * u, h - 3 * u);
  c.fillStyle = "#c0c0c0";
  c.fillRect(x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u);
}

function drawWin98(
  c: Ctx,
  image: ImageBitmap,
  x: number,
  y: number,
  title: string,
  l: ReturnType<typeof frameLayout>,
) {
  const { u, bar, border, windowWidth: w, windowHeight: h } = l;
  bevel(c, x, y, w, h, u);
  const barX = x + 3 * u;
  const barY = y + 3 * u;
  const barW = w - 6 * u;
  const gradient = c.createLinearGradient(barX, 0, barX + barW, 0);
  gradient.addColorStop(0, "#000080");
  gradient.addColorStop(1, "#1084d0");
  c.fillStyle = gradient;
  c.fillRect(barX, barY, barW, bar - 2 * u);
  c.fillStyle = "#ffffff";
  c.font = `bold ${11 * u}px "MS Sans Serif", Tahoma, Arial, sans-serif`;
  c.textBaseline = "middle";
  c.fillText(title, barX + 4 * u, barY + (bar - 2 * u) / 2, barW - 70 * u);
  // minimise, maximise and close
  const size = bar - 6 * u;
  for (let i = 0; i < 3; i++) {
    const bx = barX + barW - (3 - i) * (size + 2 * u) - (i === 2 ? 0 : 2 * u);
    const by = barY + 2 * u;
    bevel(c, bx, by, size + 2 * u, size, u);
    c.fillStyle = "#000000";
    const cx = bx + (size + 2 * u) / 2;
    const cy = by + size / 2;
    const s = Math.max(2, size / 4);
    if (i === 0) c.fillRect(cx - s, cy + s - u, 2 * s, 2 * u);
    else if (i === 1) {
      c.fillRect(cx - s, cy - s, 2 * s, 2 * u);
      c.strokeStyle = "#000000";
      c.lineWidth = u;
      c.strokeRect(cx - s + u / 2, cy - s + u / 2, 2 * s - u, 2 * s - u);
    } else {
      c.strokeStyle = "#000000";
      c.lineWidth = 1.5 * u;
      c.beginPath();
      c.moveTo(cx - s, cy - s);
      c.lineTo(cx + s, cy + s);
      c.moveTo(cx + s, cy - s);
      c.lineTo(cx - s, cy + s);
      c.stroke();
    }
  }
  const ix = x + border;
  const iy = y + border + bar;
  c.fillStyle = "#808080";
  c.fillRect(ix - u, iy - u, image.width + 2 * u, image.height + 2 * u);
  c.drawImage(image, ix, iy);
}

function drawMac(
  c: Ctx,
  image: ImageBitmap,
  x: number,
  y: number,
  title: string,
  l: ReturnType<typeof frameLayout>,
  glass: boolean,
) {
  const { u, bar, windowWidth: w, windowHeight: h } = l;
  const radius = (glass ? 18 : 10) * u;
  c.save();
  c.shadowColor = "rgba(0, 0, 0, 0.35)";
  c.shadowBlur = l.pad / 2;
  c.shadowOffsetY = l.pad / 6;
  c.beginPath();
  c.roundRect(x, y, w, h, radius);
  c.fillStyle = glass ? "rgba(255, 255, 255, 0.28)" : "#ececec";
  c.fill();
  c.restore();

  c.save();
  c.beginPath();
  c.roundRect(x, y, w, h, radius);
  c.clip();
  if (glass) {
    // frosted: the bar shows a blurred copy of the picture's top edge through white
    c.filter = `blur(${8 * u}px)`;
    c.drawImage(image, 0, 0, image.width, Math.min(image.height, bar * 2), x, y - bar, w, bar * 3);
    c.filter = "none";
    c.fillStyle = "rgba(255, 255, 255, 0.55)";
    c.fillRect(x, y, w, bar);
  } else {
    const gradient = c.createLinearGradient(0, y, 0, y + bar);
    gradient.addColorStop(0, "#f6f6f6");
    gradient.addColorStop(1, "#e3e3e3");
    c.fillStyle = gradient;
    c.fillRect(x, y, w, bar);
  }
  c.drawImage(image, x, y + bar);
  c.restore();

  const lights = glass
    ? ["rgba(255,255,255,0.9)", "rgba(255,255,255,0.7)", "rgba(255,255,255,0.5)"]
    : ["#ff5f57", "#febc2e", "#28c840"];
  for (const [i, colour] of lights.entries()) {
    c.beginPath();
    c.arc(x + (14 + i * 20) * u, y + bar / 2, 6 * u, 0, Math.PI * 2);
    c.fillStyle = colour;
    c.fill();
    if (!glass) {
      c.strokeStyle = "rgba(0, 0, 0, 0.12)";
      c.lineWidth = u;
      c.stroke();
    }
  }
  if (title) {
    c.fillStyle = glass ? "rgba(20, 20, 30, 0.85)" : "#4d4d4d";
    c.font = `600 ${13 * u}px -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(title, x + w / 2, y + bar / 2, w - 160 * u);
    c.textAlign = "start";
  }
  c.save();
  c.beginPath();
  c.roundRect(x + u / 2, y + u / 2, w - u, h - u, radius);
  c.strokeStyle = glass ? "rgba(255, 255, 255, 0.75)" : "rgba(0, 0, 0, 0.18)";
  c.lineWidth = u;
  c.stroke();
  c.restore();
}

/**
 * Puts a screenshot on a background, as a card with rounded corners and a shadow or inside a
 * window: Windows 98, liquid glass or macOS.
 */
export class frameHandler implements FormatHandler {
  public readonly name = "frame";
  public supportedFormats = [
    ...PICTURES,
    FRAMED.builder("png")
      .lossless()
      .options({ frameStyle: true, frameTitle: true, background: true })
      .to(),
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
    const style = (ctx?.options.frameStyle as string | undefined) ?? "card";
    const colours = FRAME_BACKGROUNDS[(ctx?.options.background as string | undefined) ?? "sky"];
    const outputFiles: FileData[] = [];
    for (const [i, file] of inputFiles.entries()) {
      ctx?.throwIfAborted();
      ctx?.progress(`Framing ${file.name}...`, i / inputFiles.length);
      const image = await decode(file);
      const { width: w, height: h } = image;
      const layout = frameLayout(w, h, style);
      const { pad } = layout;
      const bundle = createCanvas(layout.width, layout.height);
      const { ctx: c, canvas } = bundle;

      if (colours) {
        const gradient = c.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, colours[0]);
        gradient.addColorStop(1, colours[1]);
        c.fillStyle = gradient;
        c.fillRect(0, 0, canvas.width, canvas.height);
      }
      const title = (ctx?.options.frameTitle as string | undefined) ?? stripExt(file.name);

      if (style === "Win98 window") {
        c.save();
        c.shadowColor = "rgba(0, 0, 0, 0.35)";
        c.shadowBlur = pad / 3;
        c.shadowOffsetX = c.shadowOffsetY = pad / 10;
        c.fillStyle = "#c0c0c0";
        c.fillRect(pad, pad, layout.windowWidth, layout.windowHeight);
        c.restore();
        drawWin98(c, image, pad, pad, title, layout);
      } else if (style === "macOS window" || style === "liquid glass window") {
        drawMac(c, image, pad, pad, title, layout, style === "liquid glass window");
      } else {
        const radius = Math.max(4, Math.round(Math.max(w, h) * 0.012));
        c.save();
        c.shadowColor = "rgba(0, 0, 0, 0.35)";
        c.shadowBlur = pad / 2;
        c.shadowOffsetY = pad / 6;
        c.beginPath();
        c.roundRect(pad, pad, w, h, radius);
        c.fillStyle = "white";
        c.fill();
        c.restore();

        c.save();
        c.beginPath();
        c.roundRect(pad, pad, w, h, radius);
        c.clip();
        c.drawImage(image, pad, pad);
        c.restore();
      }
      image.close();

      outputFiles.push({
        name: changeExt(file.name, "png", "-framed"),
        bytes: await canvasToBlob(bundle, "image/png"),
      });
    }
    return outputFiles;
  }
}

/** Longest side of a halftone print: every pixel is visited once per ink. */
const HALFTONE_MAX = 2400;

/** Prints a picture as a three-colour silk screen, with src/handlers/halftone/engine.ts. */
export class halftoneHandler implements FormatHandler {
  public readonly name = "halftone";
  public supportedFormats = [...PICTURES, HALFTONE.builder("png").lossless().to()];
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
    for (const [i, file] of inputFiles.entries()) {
      ctx?.throwIfAborted();
      ctx?.progress(`Printing ${file.name}...`, i / inputFiles.length);
      const image = await decode(file);
      const scale = Math.min(1, HALFTONE_MAX / Math.max(image.width, image.height));
      const bundle = createCanvas(
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      );
      const { ctx: c, canvas } = bundle;
      // transparent parts print as paper
      c.fillStyle = "white";
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close();

      const pixels = c.getImageData(0, 0, canvas.width, canvas.height);
      // the demo's fixed screen gives dots of a pixel or two; these grow with the picture
      const cellSize = Math.max(2, Math.round(Math.max(canvas.width, canvas.height) / 240));
      pixels.data.set(halftone(pixels, cellSize));
      c.putImageData(pixels, 0, 0);
      outputFiles.push({
        name: changeExt(file.name, "png", "-halftone"),
        bytes: await canvasToBlob(bundle, "image/png"),
      });
    }
    return outputFiles;
  }
}

const escapeHtml = (char: string) =>
  char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === "&" ? "&amp;" : char;

/** Characters across a line of {@link asciiHtmlHandler}'s output. */
const ASCII_COLUMNS = 120;

/**
 * Writes a picture as characters in the colours of the picture, on black. The characters are
 * those of the plain text output (image-to-txt), which picks each by its shape.
 */
export function asciiHtml(pixels: Pixels, columns = ASCII_COLUMNS): string {
  const { width, height, data } = pixels;
  // image-to-txt's cells are 2:3, the shape of a character
  const cellWidth = Math.max(2, Math.floor(width / columns));
  const cellHeight = Math.max(3, Math.round(cellWidth * 1.5));
  const text = imageToText(
    {
      width: () => width,
      height: () => height,
      getPixel(x: number, y: number) {
        if (x >= width || y >= height) return 0;
        const i = (y * width + x) * 4;
        return rgbaToGrayscale(
          data[i] / 255,
          data[i + 1] / 255,
          data[i + 2] / 255,
          data[i + 3] / 255,
        );
      },
    },
    cellWidth,
    cellHeight,
  );

  let body = "";
  for (const [row, line] of text.split("\n").slice(0, -1).entries()) {
    let run = "";
    let runColor = "";
    for (const [column, char] of [...line].entries()) {
      // the average colour of the cell, in 4 bits a channel so that neighbours share a span
      let [r, g, b, n] = [0, 0, 0, 0];
      for (let y = row * cellHeight; y < Math.min(height, (row + 1) * cellHeight); y++) {
        for (let x = column * cellWidth; x < Math.min(width, (column + 1) * cellWidth); x++) {
          const i = (y * width + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const hex = (v: number) => Math.round(v / Math.max(1, n) / 17).toString(16);
      const color = `#${hex(r)}${hex(g)}${hex(b)}`;
      if (color !== runColor && run) {
        body += `<span style="color:${runColor}">${run}</span>`;
        run = "";
      }
      runColor = color;
      run += escapeHtml(char);
    }
    if (run) body += `<span style="color:${runColor}">${run}</span>`;
    body += "\n";
  }
  return (
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>ASCII art</title></head>\n' +
    '<body style="margin:0;background:#000">' +
    '<pre style="font:10px/1.2 ui-monospace,Menlo,Consolas,monospace;margin:1em">\n' +
    body +
    "</pre></body></html>\n"
  );
}

/** Turns a picture into coloured characters in an HTML page. */
export class asciiHtmlHandler implements FormatHandler {
  public readonly name = "asciiHtml";
  public supportedFormats = [...PICTURES, ASCII_HTML.builder("html").to()];
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
    for (const [i, file] of inputFiles.entries()) {
      ctx?.throwIfAborted();
      ctx?.progress(`Writing ${file.name} in characters...`, i / inputFiles.length);
      const image = await decode(file);
      const { width, height } = image;
      const bundle = createCanvas(width, height);
      bundle.ctx.drawImage(image, 0, 0);
      image.close();
      const pixels = bundle.ctx.getImageData(0, 0, width, height);
      outputFiles.push({
        name: changeExt(file.name, "html", "-ascii"),
        bytes: encode(asciiHtml(pixels)),
      });
    }
    return outputFiles;
  }
}
