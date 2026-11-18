import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { createCanvas } from "src/common/canvas.ts";
import { changeExt, decode, stripExt } from "src/common/index.ts";
import { escapeHtml } from "src/common/markdown.ts";
import { LOOK_IDS, lookCss, type LookName, type Palette } from "src/common/looks.ts";
import JSZip from "jszip";

export const THEME_PACK = new FormatDefinition(
  "Theme pack (Win98, glass and Xiao looks)",
  "looks",
  "zip",
  "application/zip",
  Category.ARCHIVE,
);
export const GIMP_PALETTE = new FormatDefinition(
  "GIMP palette",
  "gpl",
  "gpl",
  "application/x-gimp-palette",
  Category.DATA,
);

// --------------------------------------------------------------- colour maths, as in textarea
// (lib/customize.js of Gitguy268/textarea, MIT), so a theme code made here reads the same there

const rgbOf = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexOf = (rgb: number[]) =>
  "#" +
  rgb
    .map((c) =>
      Math.round(Math.max(0, Math.min(255, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const luminance = (hex: string) => {
  const [r, g, b] = rgbOf(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
export const mix = (a: string, b: string, amount: number) => {
  const [x, y] = [rgbOf(a), rgbOf(b)];
  return hexOf(x.map((c, i) => c + (y[i] - c) * amount));
};
/** A colour moved toward the text colour until it reads at 4.5:1 on the page. */
export function readableAccent(colour: string, page = "#ffffff", text = "#161616") {
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(colour, text, step / 20);
    if (contrast(candidate, page) >= 4.5) return candidate;
  }
  return text;
}
const saturation = (hex: string) => {
  const [r, g, b] = rgbOf(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};

/** The same code textarea's Customize panel reads: `textarea-theme:` and base64url JSON. */
export function themeCode(look: string, colours: string[]): string {
  const json = JSON.stringify({
    v: 1,
    look,
    colors: colours.slice(0, 3),
    angle: 135,
    strength: 0.35,
    grain: 0.15,
  });
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return "textarea-theme:" + base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// ------------------------------------------------------------------------------ palettes

/** The main colours of a picture, most common first, by k-means on a small copy of it. */
export function dominantColours(pixels: Uint8ClampedArray, k = 6): string[] {
  const points: number[][] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue; // transparent
    points.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  if (!points.length) return [];
  // spread the starting centres over the brightness range, so the result doesn't vary per run
  const sorted = points.toSorted((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  let centres = Array.from({ length: Math.min(k, points.length) }, (_, i) =>
    sorted[Math.floor(((i + 0.5) * sorted.length) / Math.min(k, points.length))].slice(),
  );
  let counts: number[] = [];
  for (let round = 0; round < 12; round++) {
    const sums = centres.map(() => [0, 0, 0]);
    counts = centres.map(() => 0);
    for (const p of points) {
      let best = 0;
      let bestDistance = Infinity;
      for (const [j, c] of centres.entries()) {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestDistance) [best, bestDistance] = [j, d];
      }
      counts[best]++;
      for (let ch = 0; ch < 3; ch++) sums[best][ch] += p[ch];
    }
    centres = centres.map((c, j) => (counts[j] ? sums[j].map((s) => s / counts[j]) : c));
  }
  return centres
    .map((c, j) => ({ hex: hexOf(c), count: counts[j] }))
    .filter((c) => c.count)
    .toSorted((a, b) => b.count - a.count)
    .map((c) => c.hex);
}

/** Colours from a GIMP palette or from any text with #rrggbb (or #rgb) in it. */
export function parsePalette(text: string): string[] {
  const colours: string[] = [];
  if (text.startsWith("GIMP Palette")) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(line);
      if (m) colours.push(hexOf([m[1], m[2], m[3]].map(Number)));
    }
  }
  for (const m of text.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    colours.push(`#${hex.toLowerCase()}`);
  }
  return [...new Set(colours)];
}

/** A palette from a list of colours: the most saturated one is the accent. */
export function paletteFrom(colours: string[]): Palette {
  if (!colours.length) throw new Error("No colours found.");
  const byVividness = colours.toSorted((a, b) => saturation(b) - saturation(a));
  const accent = readableAccent(byVividness[0]);
  // the background: the colours that aren't nearly grey, at most three, in the order given
  const lively = colours.filter((c) => saturation(c) > 0.12);
  const background = (lively.length >= 2 ? lively : colours).slice(0, 3);
  return {
    accent,
    background:
      background.length > 1 ? background : [background[0], mix(background[0], "#ffffff", 0.5)],
  };
}

const LOOK_LABELS: Record<LookName, string> = {
  plain: "Classic",
  Win98: "Windows 98",
  "liquid glass": "Liquid glass",
  Xiao: "Xiao",
};

function previewHtml(look: LookName, palette: Palette, code: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${LOOK_LABELS[look]} preview</title>
<link rel="stylesheet" href="css/${LOOK_IDS[look]}.css">
<style>.wrap { display: grid; place-items: center; min-height: 100vh; padding: 24px; } .panel { width: min(560px, 100%); }
.body { padding: 16px 20px; } .swatches { display: flex; gap: 8px; margin: 12px 0; } .swatches span { width: 40px; height: 40px; border-radius: 8px; border: 1px solid var(--line); }
textarea { width: 100%; font: 12px ui-monospace, monospace; }</style>
</head>
<body class="surface">
<div class="wrap"><section class="panel">
<div class="titlebar">${LOOK_LABELS[look]}</div>
<div class="body">
<h2>The quick brown fox</h2>
<p>Text on a panel, a <a href="#">link</a>, a <span class="chip">tag</span> and <code>code</code>.</p>
<div class="swatches">${[palette.accent, ...palette.background].map((c) => `<span style="background:${c}" title="${c}"></span>`).join("")}</div>
<p><button class="primary">Primary</button> <button>Button</button></p>
<p class="muted">Theme code for textarea's Customize panel:</p>
<textarea rows="3" readonly>${escapeHtml(code)}</textarea>
</div></section></div>
</body>
</html>
`;
}

/** Everything in a theme pack, by path. */
export function themePack(palette: Palette, name: string): Record<string, string> {
  const files: Record<string, string> = {};
  const codes: Record<string, string> = {};
  for (const look of Object.keys(LOOK_IDS) as LookName[]) {
    const id = LOOK_IDS[look];
    const code = themeCode(id, palette.background);
    codes[id] = code;
    files[`css/${id}.css`] =
      `/* ${name}: ${LOOK_LABELS[look]} look, made by convert's Looks generator */\n${lookCss(look, palette)}`;
    files[`preview-${id}.html`] = previewHtml(look, palette, code);
  }
  files["theme.json"] =
    JSON.stringify(
      {
        name,
        accent: palette.accent,
        background: palette.background,
        looks: Object.values(LOOK_IDS),
        textareaThemeCodes: codes,
      },
      null,
      2,
    ) + "\n";
  files["textarea-theme.txt"] = Object.entries(codes)
    .map(([id, code]) => `${id}\n${code}\n`)
    .join("\n");
  files["README.txt"] = [
    `${name}: a theme pack in four looks.`,
    "",
    `Accent ${palette.accent}, background ${palette.background.join(" → ")}.`,
    "",
    "css/*.css      a stylesheet per look, on the classes surface, panel, titlebar, chip, muted and button,",
    "               with the colours as custom properties (--accent, --bg-1 to --bg-3, --bg).",
    "preview-*.html what each look looks like. Open one next to the css folder.",
    "textarea-theme.txt  paste a code into textarea's Customize panel (Theme code) to use the colours there.",
    "theme.json     the same, for scripts.",
    "",
  ].join("\n");
  return files;
}

/** Turns a picture or a palette into the same colours in every look of the apps. */
class looksHandler implements FormatHandler {
  public readonly name = "looks";
  public supportedFormats = [
    Formats.PNG.builder("png").from(),
    Formats.JPEG.builder("jpeg").from(),
    Formats.WEBP.builder("webp").from(),
    GIMP_PALETTE.builder("gpl").from(),
    Formats.TEXT.builder("text").from(),
    THEME_PACK.builder("zip").to(),
  ];
  public ready = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    _outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const outputs: FileData[] = [];
    for (const file of inputFiles) {
      ctx?.progress(`Reading the colours of ${file.name}...`, 0.2);
      let colours: string[];
      if (inputFormat.internal === "gpl" || inputFormat.internal === "text")
        colours = parsePalette(decode(file.bytes));
      else {
        const image = await createImageBitmap(new Blob([file.bytes as BlobPart]));
        const { ctx: c } = createCanvas(64, 64);
        c.drawImage(image, 0, 0, 64, 64);
        image.close();
        colours = dominantColours(c.getImageData(0, 0, 64, 64).data);
      }
      if (!colours.length) throw new Error(`${file.name} has no colours this tool can read.`);
      const name = stripExt(file.name);
      const zip = new JSZip();
      for (const [path, content] of Object.entries(themePack(paletteFrom(colours), name))) {
        zip.file(path, content);
      }
      outputs.push({
        name: changeExt(file.name, "zip", "-looks"),
        bytes: await zip.generateAsync({ type: "uint8array" }),
      });
    }
    return outputs;
  }
}

export default looksHandler;
