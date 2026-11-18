import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { changeExt, encode, stripExt } from "src/common/index.ts";
import { escapeHtml } from "src/common/markdown.ts";
import { unzlibSync } from "fflate";

export const SUBSET_WOFF2 = new FormatDefinition(
  "Font for the web, subset (WOFF2)",
  "woff2-subset",
  "woff2",
  "font/woff2",
  [Category.FONT],
);
export const SUBSET_TTF = new FormatDefinition(
  "Font, subset (TrueType/OpenType)",
  "ttf-subset",
  "ttf",
  "font/ttf",
  [Category.FONT],
);
export const SPECIMEN = new FormatDefinition(
  "Font specimen (compares the fonts side by side)",
  "font-specimen",
  "html",
  "text/html",
  [Category.DOCUMENT, Category.FONT],
);

// ------------------------------------------------------------------------------ characters

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** What "latin" keeps: ASCII, Latin-1 and the punctuation and signs text uses most. */
const LATIN = [
  ...range(0x20, 0x7e),
  ...range(0xa0, 0xff),
  0x131,
  0x152,
  0x153,
  0x2c6,
  0x2da,
  0x2dc,
  0x2013,
  0x2014,
  0x2018,
  0x2019,
  0x201a,
  0x201c,
  0x201d,
  0x201e,
  0x2022,
  0x2026,
  0x2039,
  0x203a,
  0x2044,
  0x20ac,
  0x2122,
  0x2212,
];
const PRESETS: Record<string, number[]> = {
  latin: LATIN,
  "latin-ext": [...LATIN, ...range(0x100, 0x24f), ...range(0x1e00, 0x1eff)],
  ascii: range(0x20, 0x7e),
  digits: [0x20, ...range(0x30, 0x39), 0x2c, 0x2e, 0x2d, 0x2b, 0x25],
};

/**
 * The code points a "Characters to keep" setting asks for: a preset name (latin, latin-ext,
 * ascii, digits), U+ ranges such as `U+0041-005A`, or simply the text to keep. Several can be
 * combined with spaces or commas. Empty means latin.
 */
export function codepointsFor(setting: string | undefined): number[] {
  const text = (setting ?? "").trim();
  if (!text) return PRESETS.latin;
  const out = new Set<number>([0x20]);
  const words = text.split(/[\s,]+/).filter(Boolean);
  const special = words.every(
    (w) => PRESETS[w.toLowerCase()] || /^U\+[0-9a-f]+(-[0-9a-f]+)?$/i.test(w),
  );
  if (special) {
    for (const word of words) {
      const preset = PRESETS[word.toLowerCase()];
      if (preset) preset.forEach((c) => out.add(c));
      else {
        const [a, b] = word
          .slice(2)
          .split("-")
          .map((h) => Number.parseInt(h, 16));
        range(a, b ?? a).forEach((c) => out.add(c));
      }
    }
  } else for (const char of text) out.add(char.codePointAt(0)!);
  return [...out].toSorted((a, b) => a - b);
}

// ------------------------------------------------------------------------------ containers

/** WOFF 1 unpacked to the font inside it: each table is zlib on its own. */
export function unwoff(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flavor = view.getUint32(4);
  const numTables = view.getUint16(12);
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    const offset = view.getUint32(at + 4);
    const compLength = view.getUint32(at + 8);
    const origLength = view.getUint32(at + 12);
    const raw = bytes.subarray(offset, offset + compLength);
    tables.push({
      tag: view.getUint32(at),
      checksum: view.getUint32(at + 16),
      data: compLength < origLength ? unzlibSync(raw) : raw,
    });
  }
  const headerSize = 12 + 16 * numTables;
  const total = headerSize + tables.reduce((n, t) => n + ((t.data.length + 3) & ~3), 0);
  const out = new Uint8Array(total);
  const o = new DataView(out.buffer);
  o.setUint32(0, flavor);
  o.setUint16(4, numTables);
  const power = 2 ** Math.floor(Math.log2(numTables));
  o.setUint16(6, power * 16);
  o.setUint16(8, Math.log2(power));
  o.setUint16(10, numTables * 16 - power * 16);
  let offset = headerSize;
  for (const [i, t] of tables.entries()) {
    const at = 12 + i * 16;
    o.setUint32(at, t.tag);
    o.setUint32(at + 4, t.checksum);
    o.setUint32(at + 8, offset);
    o.setUint32(at + 12, t.data.length);
    out.set(t.data, offset);
    offset += (t.data.length + 3) & ~3;
  }
  return out;
}

const magic = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(0, 4));

/** The plain font (TTF or OTF) inside any of the font files this reads. */
export async function sfntOf(bytes: Uint8Array): Promise<Uint8Array> {
  const tag = magic(bytes);
  if (tag === "wOF2") {
    const { decompress } = await import("woff2-encoder");
    return decompress(bytes);
  }
  if (tag === "wOFF") return unwoff(bytes);
  return bytes;
}

// ------------------------------------------------------------------------------ subsetting

interface HbExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(data: number, length: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

/** HB_MEMORY_MODE_READONLY: harfbuzz reads the font where it is. */
const READONLY = 1;

/**
 * A font cut down to the given characters with HarfBuzz's subsetter (the one Google Fonts
 * uses): the glyphs they need, and the layout rules between them, stay.
 */
export function subsetFont(hb: HbExports, font: Uint8Array, codepoints: number[]): Uint8Array {
  const ptr = hb.malloc(font.length);
  new Uint8Array(hb.memory.buffer).set(font, ptr);
  const blob = hb.hb_blob_create(ptr, font.length, READONLY, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  try {
    if (!input) throw new Error("HarfBuzz could not start a subset.");
    const set = hb.hb_subset_input_unicode_set(input);
    for (const codepoint of codepoints) hb.hb_set_add(set, codepoint);
    const subset = hb.hb_subset_or_fail(face, input);
    if (!subset)
      throw new Error("This font could not be subset: it may be damaged or a collection.");
    const result = hb.hb_face_reference_blob(subset);
    const data = hb.hb_blob_get_data(result, 0);
    const length = hb.hb_blob_get_length(result);
    const out = new Uint8Array(hb.memory.buffer).slice(data, data + length);
    hb.hb_blob_destroy(result);
    hb.hb_face_destroy(subset);
    if (!out.length) throw new Error("None of those characters are in this font.");
    return out;
  } finally {
    if (input) hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(ptr);
  }
}

let harfbuzz: Promise<HbExports> | undefined;

async function loadHarfbuzz(): Promise<HbExports> {
  harfbuzz ??= (async () => {
    const { default: url } = await import("harfbuzzjs/dist/harfbuzz-subset.wasm?url");
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {});
    return instance.exports as unknown as HbExports;
  })();
  harfbuzz.catch(() => (harfbuzz = undefined));
  return harfbuzz;
}

// ------------------------------------------------------------------------------ specimen

export interface FontInfo {
  family: string;
  style: string;
  glyphs: number;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  version?: string;
  designer?: string;
  license?: string;
  codepoints: number[];
}

/** What a font says about itself, with opentype.js. */
export async function fontInfo(sfnt: Uint8Array): Promise<FontInfo> {
  const { parse } = await import("opentype.js");
  const font = parse(
    sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength) as ArrayBuffer,
  );
  // opentype.js 2 keeps the names per platform; older files may only have one of them
  type Names = Record<string, { en?: string } | undefined>;
  const all = font.names as unknown as Names & { macintosh?: Names; windows?: Names };
  const names: Names = { ...all.macintosh, ...all.windows, ...all };
  const codepoints = new Set<number>();
  for (let i = 0; i < font.glyphs.length; i++) {
    const glyph = font.glyphs.get(i);
    for (const u of glyph.unicodes ?? []) codepoints.add(u);
  }
  return {
    family: names.preferredFamily?.en ?? names.fontFamily?.en ?? "Unnamed font",
    style: names.preferredSubfamily?.en ?? names.fontSubfamily?.en ?? "Regular",
    glyphs: font.glyphs.length,
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
    version: names.version?.en,
    designer: names.designer?.en,
    license: names.license?.en,
    codepoints: [...codepoints].toSorted((a, b) => a - b),
  };
}

const SCRIPTS: [string, number, number][] = [
  ["Basic Latin", 0x20, 0x7e],
  ["Latin-1", 0xa0, 0xff],
  ["Latin Extended", 0x100, 0x24f],
  ["Greek", 0x370, 0x3ff],
  ["Cyrillic", 0x400, 0x4ff],
  ["Hebrew", 0x590, 0x5ff],
  ["Arabic", 0x600, 0x6ff],
  ["Devanagari", 0x900, 0x97f],
  ["Thai", 0xe00, 0xe7f],
  ["Punctuation", 0x2000, 0x206f],
  ["Currency", 0x20a0, 0x20cf],
  ["Arrows", 0x2190, 0x21ff],
  ["Maths", 0x2200, 0x22ff],
  ["Box drawing", 0x2500, 0x257f],
  ["CJK", 0x4e00, 0x9fff],
];

/** How much of each script a font covers, for the ones it has at least one character of. */
export function coverage(codepoints: number[]): { script: string; has: number; of: number }[] {
  return SCRIPTS.map(([script, from, to]) => ({
    script,
    has: codepoints.filter((c) => c >= from && c <= to).length,
    of: to - from + 1,
  })).filter((s) => s.has > 0);
}

const FONT_TYPE: Record<string, string> = { wOF2: "woff2", wOFF: "woff", OTTO: "opentype" };

/** One HTML page with every font in it, to compare them in the same words at the same sizes. */
export function specimenHtml(fonts: { name: string; bytes: Uint8Array; info: FontInfo }[]): string {
  const faces = fonts
    .map((font, i) => {
      const format = FONT_TYPE[magic(font.bytes)] ?? "truetype";
      let binary = "";
      for (let j = 0; j < font.bytes.length; j += 0x8000) {
        binary += String.fromCharCode(...font.bytes.subarray(j, j + 0x8000));
      }
      return `@font-face { font-family: "specimen-${i}"; src: url(data:font/${format === "opentype" ? "otf" : format};base64,${btoa(binary)}) format("${format}"); }`;
    })
    .join("\n");
  const label = (font: (typeof fonts)[number]) =>
    `${escapeHtml(font.info.family)} ${escapeHtml(font.info.style)}`;
  const sample = "The quick brown fox jumps over the lazy dog. 0123456789";
  const compare = fonts
    .map(
      (font, i) =>
        `<tr><th scope="row">${label(font)}</th><td style="font-family: specimen-${i}" contenteditable="true" spellcheck="false">${sample}</td></tr>`,
    )
    .join("");
  const sections = fonts
    .map((font, i) => {
      const { info } = font;
      const glyphs = info.codepoints
        .filter((c) => c > 0x20 && !(c >= 0x7f && c < 0xa0))
        .slice(0, 600)
        .map(
          (c) =>
            `<span title="U+${c.toString(16).toUpperCase().padStart(4, "0")}">${escapeHtml(String.fromCodePoint(c))}</span>`,
        )
        .join("");
      const sizes = [12, 16, 24, 36, 48, 72]
        .map(
          (size) =>
            `<p style="font-size: ${size}px"><span class="size">${size}</span>${escapeHtml(sample)}</p>`,
        )
        .join("");
      const facts = [
        ["File", escapeHtml(font.name)],
        ["Glyphs", String(info.glyphs)],
        ["Characters", String(info.codepoints.length)],
        ["Units per em", String(info.unitsPerEm)],
        ["Ascender / descender", `${info.ascender} / ${info.descender}`],
        ...(info.version ? [["Version", escapeHtml(info.version)]] : []),
        ...(info.designer ? [["Designer", escapeHtml(info.designer)]] : []),
        ...(info.license ? [["Licence", escapeHtml(info.license.slice(0, 300))]] : []),
        [
          "Covers",
          coverage(info.codepoints)
            .map((s) => `${s.script} ${Math.round((100 * s.has) / s.of)}%`)
            .join(", "),
        ],
      ]
        .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
        .join("");
      return `<section>
<h2>${label(font)}</h2>
<dl>${facts}</dl>
<div class="waterfall" style="font-family: specimen-${i}">${sizes}</div>
<div class="glyphs" style="font-family: specimen-${i}">${glyphs}</div>
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:">
<title>${fonts.map(label).join(", ")}</title>
<style>
${faces}
:root { color-scheme: light dark; --line: #8884; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 24px 16px 64px; max-width: 1100px; }
h1 { font-size: 22px; } h2 { font-size: 18px; margin-top: 48px; border-top: 1px solid var(--line); padding-top: 24px; }
table { width: 100%; border-collapse: collapse; } th { text-align: left; font-weight: 600; width: 220px; vertical-align: top; padding: 10px 12px 10px 0; }
td { font-size: 28px; padding: 6px 0; border-bottom: 1px solid var(--line); outline: none; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; font-size: 13px; } dt { color: GrayText; }
.waterfall p { margin: 0.2em 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.size { display: inline-block; width: 3em; font: 11px system-ui; color: GrayText; }
.glyphs { display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin-top: 16px; font-size: 26px; }
.glyphs span { background: Canvas; text-align: center; padding: 6px 0; }
@media (max-width: 600px) { th { width: auto; display: block; } td { display: block; } }
</style>
</head>
<body>
<h1>Font specimen</h1>
<p>Click a line to type your own text in every font.</p>
<table>${compare}</table>
${sections}
</body>
</html>
`;
}

/** Subsets fonts for the web and compares fonts on one page. */
class fontLabHandler implements FormatHandler {
  public readonly name = "fontLab";
  public supportedFormats = [
    Formats.TTF.builder("ttf").from(),
    Formats.OTF.builder("otf").from(),
    Formats.WOFF.builder("woff").from(),
    Formats.WOFF2.builder("woff2").from(),
    SUBSET_WOFF2.builder("woff2").options({ subsetText: true }).to(),
    SUBSET_TTF.builder("ttf").options({ subsetText: true }).to(),
    SPECIMEN.builder("html").to(),
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
    if (outputFormat.format === "font-specimen") {
      ctx?.progress("Reading the fonts...", 0.2);
      const fonts = [];
      for (const file of inputFiles) {
        fonts.push({
          name: file.name,
          bytes: file.bytes,
          info: await fontInfo(await sfntOf(file.bytes)),
        });
      }
      const name =
        inputFiles.length > 1
          ? `${stripExt(inputFiles[0].name)}-and-more`
          : stripExt(inputFiles[0].name);
      return [{ name: `${name}-specimen.html`, bytes: encode(specimenHtml(fonts)) }];
    }

    const hb = await loadHarfbuzz();
    const codepoints = codepointsFor(ctx?.options.subsetText as string | undefined);
    const outputs: FileData[] = [];
    for (const [i, file] of inputFiles.entries()) {
      ctx?.throwIfAborted();
      ctx?.progress(`Subsetting ${file.name}...`, i / inputFiles.length);
      const subset = subsetFont(hb, await sfntOf(file.bytes), codepoints);
      if (outputFormat.format === "woff2-subset") {
        const { compress } = await import("woff2-encoder");
        outputs.push({
          name: changeExt(file.name, "woff2", "-subset"),
          bytes: await compress(subset),
        });
      } else {
        const extension = magic(subset) === "OTTO" ? "otf" : "ttf";
        outputs.push({ name: changeExt(file.name, extension, "-subset"), bytes: subset });
      }
    }
    return outputs;
  }
}

export default fontLabHandler;
