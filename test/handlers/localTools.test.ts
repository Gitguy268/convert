import { expect, test } from "bun:test";
import {
  describeFound,
  findMetadata,
  orientationExif,
  readExif,
  stripJpeg,
  stripPng,
  stripWebp,
} from "../../src/handlers/stripMetadata.ts";
import { deckHtml, slideBlocks, splitSlides } from "../../src/handlers/slides.ts";
import { boardHtml, moveLine, readCards } from "../../src/handlers/kanban.ts";
import {
  contrast,
  dominantColours,
  paletteFrom,
  parsePalette,
  themeCode,
  themePack,
} from "../../src/handlers/looks.ts";
import { inlineCss, inlinePage, parseMhtml } from "../../src/handlers/archive.ts";
import { isIdentity, isRecipientList } from "../../src/handlers/age.ts";
import { inline, renderMarkdown } from "../../src/common/markdown.ts";
import { frameLayout } from "../../src/handlers/imageTools.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (Uint8Array | number[])[]) => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

/** A TIFF block with an orientation, a camera make and a GPS position (52°22'N 4°53'E). */
function exifWithGps(): Uint8Array {
  const b = new Uint8Array(200);
  const v = new DataView(b.buffer);
  b.set([0x4d, 0x4d]);
  v.setUint16(2, 42);
  v.setUint32(4, 8);
  // IFD0 at 8: three entries
  v.setUint16(8, 3);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    v.setUint16(at, tag);
    v.setUint16(at + 2, type);
    v.setUint32(at + 4, count);
    v.setUint32(at + 8, value);
  };
  entry(10, 0x0112, 3, 1, 6 << 16); // orientation 6, a SHORT in the first two bytes
  entry(22, 0x010f, 2, 6, 120); // make at 120
  entry(34, 0x8825, 4, 1, 50); // GPS IFD at 50
  b.set(enc("Canon\0"), 120);
  // GPS IFD at 50: four entries
  v.setUint16(50, 4);
  entry(52, 1, 2, 2, 0x4e000000); // "N"
  entry(64, 2, 5, 3, 140);
  entry(76, 3, 2, 2, 0x45000000); // "E"
  entry(88, 4, 5, 3, 164);
  const rationals = (at: number, values: number[]) =>
    values.forEach((n, i) => {
      v.setUint32(at + i * 8, n);
      v.setUint32(at + i * 8 + 4, 1);
    });
  rationals(140, [52, 22, 0]);
  rationals(164, [4, 53, 0]);
  return b;
}

const segment = (marker: number, body: Uint8Array) =>
  cat([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff], body);

function jpegWithExif(): Uint8Array {
  return cat(
    [0xff, 0xd8],
    segment(0xe0, enc("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    segment(0xe1, cat(enc("Exif\0\0"), exifWithGps())),
    segment(0xe1, enc("http://ns.adobe.com/xap/1.0/\0<x/>")),
    segment(0xe2, enc("ICC_PROFILE\0\x01\x01data")),
    segment(0xfe, enc("a comment")),
    segment(0xdb, new Uint8Array(65)), // quantisation table
    [0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9], // scan and end
  );
}

test("readExif finds the orientation, the camera and the GPS position", () => {
  const exif = readExif(exifWithGps());
  expect(exif.orientation).toBe(6);
  expect(exif.make).toBe("Canon");
  expect(exif.gps!.latitude).toBeCloseTo(52.3667, 3);
  expect(exif.gps!.longitude).toBeCloseTo(4.8833, 3);
});

test("stripJpeg keeps the picture, JFIF, the profile and the orientation, and nothing else", () => {
  const jpeg = jpegWithExif();
  const found = findMetadata(jpeg);
  expect(found.kinds).toEqual(["EXIF", "XMP", "comments", "GPS location"]);
  expect(describeFound("a.jpg", found)).toContain("GPS location 52.36667°N 4.88333°E");

  const clean = stripJpeg(jpeg);
  const after = findMetadata(clean);
  expect(after.kinds).toEqual(["EXIF"]); // the orientation alone
  expect(after.exif).toEqual({ orientation: 6 });
  const text = new TextDecoder("latin1").decode(clean);
  expect(text).toContain("JFIF");
  expect(text).toContain("ICC_PROFILE");
  expect(text).not.toContain("Canon");
  expect(text).not.toContain("a comment");
  // the scan is copied byte for byte
  expect(Array.from(clean.slice(-9))).toEqual([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
});

test("orientationExif reads back as the orientation it was given", () => {
  expect(readExif(orientationExif(8).subarray(6))).toEqual({ orientation: 8 });
});

function pngChunk(type: string, body: Uint8Array) {
  const out = new Uint8Array(12 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(enc(type), 4);
  out.set(body, 8);
  return out; // CRC left at zero: nothing here checks it
}

test("stripPng drops text, EXIF and time chunks and keeps the rest in order", () => {
  const png = cat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("tEXt", enc("Author\0me")),
    pngChunk("eXIf", exifWithGps()),
    pngChunk("iCCP", enc("p")),
    pngChunk("IDAT", new Uint8Array(5)),
    pngChunk("tIME", new Uint8Array(7)),
    pngChunk("IEND", new Uint8Array(0)),
  );
  expect(findMetadata(png).kinds).toEqual(["text", "EXIF", "time it was changed", "GPS location"]);
  const clean = stripPng(png);
  expect(findMetadata(clean).kinds).toEqual([]);
  const types = new TextDecoder("latin1").decode(clean);
  expect(["IHDR", "iCCP", "IDAT", "IEND"].every((t) => types.includes(t))).toBe(true);
  expect(clean.length).toBe(png.length - (12 + 9) - (12 + 200) - (12 + 7));
});

test("stripWebp drops EXIF and XMP, clears their flags and fixes the RIFF size", () => {
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    out.set(enc(type));
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x0c | 0x10; // EXIF, XMP and alpha
  const body = cat(
    enc("WEBP"),
    chunk("VP8X", vp8x),
    chunk("VP8L", new Uint8Array(9)),
    chunk("EXIF", exifWithGps()),
    chunk("XMP ", enc("<x/>")),
  );
  const webp = cat(enc("RIFF"), new Uint8Array(4), body);
  new DataView(webp.buffer).setUint32(4, webp.length - 8, true);
  expect(findMetadata(webp).kinds).toEqual(["EXIF", "XMP", "GPS location"]);

  const clean = stripWebp(webp);
  expect(findMetadata(clean).kinds).toEqual([]);
  expect(new DataView(clean.buffer).getUint32(4, true)).toBe(clean.length - 8);
  expect(clean[20]).toBe(0x10); // only the alpha flag is left
});

test("findMetadata never throws on a file it can't read", () => {
  expect(findMetadata(enc("not a picture"))).toEqual({ kinds: [] });
  expect(findMetadata(new Uint8Array([0xff, 0xd8, 0x00]))).toEqual({ kinds: [] });
});

test("markdown escapes HTML and keeps only safe links and data images", () => {
  expect(inline("<b>hi</b> **bold** `x<y`")).toBe(
    "&lt;b&gt;hi&lt;/b&gt; <strong>bold</strong> <code>x&lt;y</code>",
  );
  expect(inline("[a](javascript:alert(1)) [b](https://x.org)")).toBe(
    'a <a href="https://x.org">b</a>',
  );
  expect(inline("![p](https://x.org/p.png) ![q](data:image/png;base64,AA)")).toBe(
    'p <img alt="q" src="data:image/png;base64,AA">',
  );
  const html = renderMarkdown(
    "# T\n\n- [x] done\n- [ ] open\n\n```js\n<script>\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  );
  expect(html).toContain("<h1>T</h1>");
  expect(html).toContain('<input type="checkbox" disabled checked> done');
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("<td>1</td>");
});

test("splitSlides cuts at --- when there is one, at headings otherwise, and drops notes", () => {
  const ruled = "---\ntitle: x\n---\n# One\ntext\nNote: say hi\n---\n## Two\n```\n---\n```\n";
  expect(splitSlides(ruled).map((s) => s.body)).toEqual(["# One\ntext", "## Two\n```\n---\n```"]);
  expect(splitSlides(ruled)[0].notes).toBe("say hi");
  expect(splitSlides("# A\na\n## B\nb\n### c\n").map((s) => s.body)).toEqual([
    "# A\na",
    "## B\nb\n### c",
  ]);
  expect(splitSlides("\n\n")).toEqual([]);
});

test("deckHtml is one file with every slide and no outside requests", () => {
  const html = deckHtml("Talk & <stuff>", [{ body: "# A" }, { body: "## B" }], "Win98");
  expect(html.match(/class="slide panel"/g)!.length).toBe(2);
  expect(html).toContain("<title>Talk &amp; &lt;stuff&gt;</title>");
  expect(html).toContain("default-src 'none'");
  expect(html).not.toMatch(/src="http|href="http/);
});

test("slideBlocks reduces a slide to what a PDF page shows", () => {
  expect(slideBlocks("# Hi **there**\n- one\n  - [x] two\ntext\nmore\n```\ncode\n```")).toEqual([
    { kind: "heading", level: 1, text: "Hi there" },
    { kind: "item", depth: 0, text: "one", box: false, checked: false },
    { kind: "item", depth: 1, text: "two", box: true, checked: true },
    { kind: "text", text: "text more" },
    { kind: "code", text: "code" },
  ]);
});

const NOTE = [
  "# Week",
  "## Home",
  "- [ ] call mum #family 📅 2026-11-20 🔺",
  "- [/] paint the shed",
  "## Work",
  "- [x] ship it ✅ 2026-11-01",
  "- [-] old idea",
  "```",
  "- [ ] not a task, in code",
  "```",
  "- plain item",
].join("\n");

test("readCards reads the tasks of a textarea-plus note into columns", () => {
  const cards = readCards(NOTE);
  expect(cards.map((c) => [c.line, c.column, c.text])).toEqual([
    [2, "todo", "call mum"],
    [3, "doing", "paint the shed"],
    [5, "done", "ship it"],
    [6, "cancelled", "old idea"],
  ]);
  expect(cards[0]).toMatchObject({
    section: "Home",
    due: "2026-11-20",
    priority: "highest",
    tags: ["family"],
  });
});

test("moveLine changes only the status, and the done date with it", () => {
  expect(moveLine("- [ ] call mum 📅 2026-11-20", "x", "2026-11-18")).toBe(
    "- [x] call mum 📅 2026-11-20 ✅ 2026-11-18",
  );
  expect(moveLine("- [x] ship it ✅ 2026-11-01", "/", "2026-11-18")).toBe("- [/] ship it");
  expect(moveLine("  * [ ] keep ^abc", "x", "2026-11-18")).toBe("  * [x] keep ✅ 2026-11-18 ^abc");
  expect(moveLine("no task", "x", "2026-11-18")).toBe("no task");
});

test("boardHtml carries the note inside it, safe from closing the script", () => {
  const html = boardHtml("Week", NOTE + "\n- [ ] </script><b>", "week.md", "plain");
  const json = /<script type="application\/json" id="note">(.*?)<\/script>/s.exec(html)![1];
  expect(JSON.parse(json).lines.at(-1)).toBe("- [ ] </script><b>");
  expect(html.match(/class="card panel"/g)!.length).toBe(5);
  expect(html).toContain("&lt;/script&gt;&lt;b&gt;");
});

test("looks: palettes from text and pictures, readable accents and textarea theme codes", () => {
  expect(parsePalette("GIMP Palette\nName: x\n255   0   0 red\n  0 128 255\n")).toEqual([
    "#ff0000",
    "#0080ff",
  ]);
  expect(parsePalette("accent #ABC, bg #112233 and #ff0000")).toEqual([
    "#aabbcc",
    "#112233",
    "#ff0000",
  ]);

  const pixels = new Uint8ClampedArray(4 * 100);
  for (let i = 0; i < 100; i++) pixels.set(i < 70 ? [250, 40, 40, 255] : [30, 60, 220, 255], i * 4);
  const colours = dominantColours(pixels, 3);
  expect(colours[0]).toBe("#fa2828");
  expect(colours).toContain("#1e3cdc");

  const palette = paletteFrom(colours);
  expect(contrast(palette.accent, "#ffffff")).toBeGreaterThanOrEqual(4.5);

  const code = themeCode("glass", ["#ff0000", "#00ff00"]);
  const json = JSON.parse(
    atob(code.slice("textarea-theme:".length).replaceAll("-", "+").replaceAll("_", "/")),
  );
  expect(json).toEqual({
    v: 1,
    look: "glass",
    colors: ["#ff0000", "#00ff00"],
    angle: 135,
    strength: 0.35,
    grain: 0.15,
  });

  const pack = themePack(palette, "test");
  expect(Object.keys(pack).toSorted()).toEqual([
    "README.txt",
    "css/classic.css",
    "css/glass.css",
    "css/win97.css",
    "css/xiao.css",
    "preview-classic.html",
    "preview-glass.html",
    "preview-win97.html",
    "preview-xiao.html",
    "textarea-theme.txt",
    "theme.json",
  ]);
  expect(pack["css/glass.css"]).toContain(`--accent: ${palette.accent}`);
});

test("parseMhtml reads the page and its parts in every transfer encoding", () => {
  const mhtml = [
    "From: <Saved by Blink>",
    "Snapshot-Content-Location: https://example.org/a/",
    'Content-Type: multipart/related; type="text/html"; boundary="----B"',
    "",
    "------B",
    "Content-Type: text/html",
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Location: https://example.org/a/",
    "",
    '<html><head><link rel=3D"stylesheet" href=3D"s.css"></head><body><img src=3D"p.png"><a href=3D"/b">b</a><script>x()</script></body></html>',
    "------B",
    "Content-Type: text/css",
    "Content-Location: https://example.org/a/s.css",
    "",
    "body { background: url(bg.gif) }",
    "------B",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-Location: https://example.org/a/p.png",
    "",
    "iVBORw==",
    "------B",
    "Content-Type: image/gif",
    "Content-Transfer-Encoding: base64",
    "Content-Location: https://example.org/a/bg.gif",
    "",
    "R0lG",
    "------B--",
  ].join("\r\n");
  const saved = parseMhtml(enc(mhtml));
  expect(saved.base).toBe("https://example.org/a/");
  expect([...saved.resources.keys()]).toEqual([
    "https://example.org/a/s.css",
    "https://example.org/a/p.png",
    "https://example.org/a/bg.gif",
  ]);

  const { html, missing } = inlinePage(saved.page, saved.base, saved.resources);
  expect(missing).toBe(0);
  expect(html).toContain('src="data:image/png;base64,iVBORw=="');
  expect(html).toContain('url("data:image/gif;base64,R0lG")');
  expect(html).toContain('href="https://example.org/b"');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<link");
  expect(html).toContain("default-src 'none'");
});

test("inlineCss follows imports and leaves what it can't find empty", () => {
  const resources = new Map([
    [
      "zip:/page_files/a.css",
      { type: "text/css", bytes: enc("@import 'b.css'; .a { color: red }") },
    ],
    [
      "zip:/page_files/b.css",
      { type: "text/css", bytes: enc(".b { background: url('../i.png') }") },
    ],
    ["zip:/i.png", { type: "image/png", bytes: enc("PNG") }],
  ]);
  const css = inlineCss(
    "@import url(page_files/a.css); x { background: url(gone.png) }",
    "zip:/page.html",
    resources,
  );
  expect(css).toContain(".a { color: red }");
  expect(css).toContain(`url("data:image/png;base64,${btoa("PNG")}")`);
  expect(css).toContain("url()");
});

test("age tells passphrases, public keys and secret keys apart", () => {
  expect(isRecipientList("age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p")).toBe(
    true,
  );
  expect(isRecipientList("correct horse battery staple")).toBe(false);
  expect(isIdentity("AGE-SECRET-KEY-1QQQQQQ")).toBe(true);
  expect(isIdentity("age1abc")).toBe(false);
});

test("frameLayout makes room for each kind of window", () => {
  expect(frameLayout(1000, 500, "card")).toMatchObject({ bar: 0, width: 1160, height: 660 });
  const win = frameLayout(1000, 500, "Win98 window");
  expect(win.bar).toBe(20);
  expect(win.windowWidth).toBe(1008);
  expect(frameLayout(1800, 900, "macOS window").bar).toBe(56);
});

const ageCtx = (passphrase?: string) =>
  ({
    options: { passphrase },
    progress() {},
    log() {},
    throwIfAborted() {},
    signal: new AbortController().signal,
  }) as never;

test("age encrypts with a passphrase and opens again, one file or a vault of several", async () => {
  const { default: AgeHandler, AGE, AGE_OPENED } = await import("../../src/handlers/age.ts");
  const handler = new AgeHandler();
  const age = AGE.builder("age").to();
  const opened = AGE_OPENED.builder("age-opened").to();
  const any = { ...age, internal: "ANY" };

  const [locked] = await handler.doConvert(
    [{ name: "note.md", bytes: enc("# secret") }],
    any,
    age,
    ageCtx("pw"),
  );
  expect(locked.name).toBe("note.md.age");
  expect(new TextDecoder().decode(locked.bytes.subarray(0, 21))).toBe("age-encryption.org/v1");
  const [back] = await handler.doConvert([locked], age, opened, ageCtx("pw"));
  expect(back).toEqual({ name: "note.md", bytes: enc("# secret") });
  await expect(handler.doConvert([locked], age, opened, ageCtx("wrong"))).rejects.toThrow(
    "did not open",
  );
  await expect(handler.doConvert([locked], age, opened, ageCtx())).rejects.toThrow("passphrase");

  const [vault] = await handler.doConvert(
    [
      { name: "a.txt", bytes: enc("a") },
      { name: "b.txt", bytes: enc("b") },
    ],
    any,
    age,
    ageCtx("pw"),
  );
  expect(vault.name).toBe("a-vault.zip.age");
  const [zip] = await handler.doConvert([vault], age, opened, ageCtx("pw"));
  expect(zip.name).toBe("a-vault.zip");
  expect([...zip.bytes.subarray(0, 2)]).toEqual([0x50, 0x4b]);
}, 30_000);

test("Font Lab subsets a font to the characters asked for and describes it", async () => {
  const { codepointsFor, subsetFont, fontInfo, specimenHtml, unwoff, sfntOf } =
    await import("../../src/handlers/fontLab.ts");
  const fontPath = "built/typst-assets/files/fonts/DejaVuSansMono.ttf";
  if (!(await Bun.file(fontPath).exists())) return; // needs `bun run build:assemble`
  const font = new Uint8Array(await Bun.file(fontPath).arrayBuffer());
  const wasm = await Bun.file("node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm").arrayBuffer();
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const hb = instance.exports as never;

  expect(codepointsFor("Hi!")).toEqual([0x20, 0x21, 0x48, 0x69]);
  expect(codepointsFor("U+41-43 digits")).toContain(0x42);
  expect(codepointsFor("")).toContain(0xe9);

  const subset = subsetFont(hb, font, codepointsFor("Hello"));
  expect(subset.length).toBeLessThan(font.length / 10);
  const info = await fontInfo(subset);
  expect(info.codepoints).toEqual([0x20, 0x48, 0x65, 0x6c, 0x6f]);
  expect(info.family).toBe("DejaVu Sans Mono");

  // a WOFF 1 made by hand from the subset reads back as the same font
  const { zlibSync } = await import("fflate");
  const view = new DataView(subset.buffer);
  const n = view.getUint16(4);
  const tables = Array.from({ length: n }, (_, i) => ({
    tag: view.getUint32(12 + i * 16),
    checksum: view.getUint32(12 + i * 16 + 4),
    data: subset.slice(
      view.getUint32(12 + i * 16 + 8),
      view.getUint32(12 + i * 16 + 8) + view.getUint32(12 + i * 16 + 12),
    ),
  }));
  // a table that zlib can't shrink is stored as it is, as the WOFF spec says
  const packed = tables.map((t) => {
    const z = zlibSync(t.data);
    return { ...t, comp: z.length < t.data.length ? z : t.data };
  });
  const size = 44 + 20 * n + packed.reduce((s, t) => s + ((t.comp.length + 3) & ~3), 0);
  const woff = new Uint8Array(size);
  const w = new DataView(woff.buffer);
  woff.set(new TextEncoder().encode("wOFF"));
  w.setUint32(4, view.getUint32(0));
  w.setUint16(12, n);
  let offset = 44 + 20 * n;
  packed.forEach((t, i) => {
    const at = 44 + i * 20;
    w.setUint32(at, t.tag);
    w.setUint32(at + 4, offset);
    w.setUint32(at + 8, t.comp.length);
    w.setUint32(at + 12, t.data.length);
    w.setUint32(at + 16, t.checksum);
    woff.set(t.comp, offset);
    offset += (t.comp.length + 3) & ~3;
  });
  expect((await fontInfo(unwoff(woff))).codepoints).toEqual(info.codepoints);
  expect((await fontInfo(await sfntOf(woff))).glyphs).toBe(info.glyphs);

  const html = specimenHtml([{ name: "a.ttf", bytes: subset, info }]);
  expect(html).toContain("DejaVu Sans Mono Book");
  expect(html).toContain('format("truetype")');
});

test("image to 3D: splats above the threshold, a standard PLY and a closed surface", async () => {
  const { selectSplats, splatPly, densityField, marchingCubes, CELLS } =
    await import("../../src/handlers/imageTo3d.ts");
  const raw = new Float32Array(CELLS * 15);
  // one confident cell at the centre and one below the threshold
  raw.set([3, 0, 0, 0, 1, 0, 0, 0.18, 0.18, 0.18, 1, 0, 0, 0, 0.9], 0);
  raw.set([0.2, 0.3, 0, 0, 0, 1, 0, 0.05, 0.05, 0.05, 1, 0, 0, 0, 0.9], 15);
  const splats = selectSplats(raw);
  expect(splats.length).toBe(1);
  expect(splats[0].rgb).toEqual([1, 0, 0]);

  const ply = splatPly(splats);
  const header = new TextDecoder("latin1").decode(ply);
  expect(header).toStartWith(
    "ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\n",
  );
  expect(ply.length).toBe(header.indexOf("end_header\n") + 11 + 17 * 4);

  const { positions, colours } = marchingCubes(densityField(splats));
  expect(positions.length).toBeGreaterThan(300);
  // a ball: every point about as far from the centre, and red
  const radii = [];
  for (let i = 0; i < positions.length; i += 3)
    radii.push(Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
  expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.03);
  expect(colours[0]).toBeCloseTo(1, 3);
  expect(colours[1]).toBeCloseTo(0, 3);
});
