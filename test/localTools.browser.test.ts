import { afterAll, expect, test } from "bun:test";
import puppeteer from "puppeteer";
import { preview } from "vite";
import type { FileData, FileFormat, FormatHandler } from "../src/FormatHandler.js";
import type { HandlerName } from "../src/handlers/index.js";
import type { ConvertOptions } from "../src/Settings.js";

/**
 * The browser-local tools in the built app, through the same conversion routes the page uses:
 * each test picks a tool's output format and checks the file that comes back. Runs against
 * dist/, so `bun run build && bun run cache:build` first.
 */

const server = await preview({
  logLevel: "silent",
  preview: { port: 0 },
  plugins: [
    {
      name: "test-resources",
      configurePreviewServer(server) {
        server.middlewares.use("/test", (req, res, next) => {
          Bun.file(`${__dirname}/resources/${req.url!.replaceAll("..", "")}`)
            .bytes()
            .then(
              (bytes) => res.end(bytes),
              () => next(),
            );
        });
      },
    },
  ],
});

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await Promise.all([
  new Promise((resolve) => {
    page.on("console", (msg) => {
      if (msg.text() === "Built initial format list.") resolve(null);
    });
  }),
  page.goto(server.resolvedUrls!.local[0]),
]);

afterAll(async () => {
  await browser.close();
  await server.close();
});

const dummyHandler: FormatHandler = {
  name: "dummy" as HandlerName,
  ready: true,
  async init() {},
  async doConvert() {
    return [];
  },
};

type Input = string | { name: string; bytes: Uint8Array | string };

/** The format the app lists for this short name and MIME type. */
async function format(id: string, mime?: string): Promise<FileFormat> {
  const found = await page.evaluate(
    (id, mime) =>
      window.handlerDefs
        .flatMap((h) => h.supportedFormats ?? [])
        .find((f) => f.format === id && (!mime || f.mime === mime)),
    id,
    mime,
  );
  if (!found) throw new Error(`No format ${id} in the app.`);
  return found;
}

/** Converts files (test/resources names, or bytes) and returns the outputs as bytes. */
async function convert(
  inputs: Input[],
  from: FileFormat,
  to: FileFormat,
  settings?: ConvertOptions,
) {
  const files = inputs.map((input) =>
    typeof input === "string"
      ? { url: `/test/${input}`, name: input }
      : {
          name: input.name,
          base64: Buffer.from(
            typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes,
          ).toString("base64"),
        },
  );
  const result = await page.evaluate(
    async (files, from, to, settings) => {
      const data: FileData[] = [];
      for (const file of files as { name: string; url?: string; base64?: string }[]) {
        const bytes = file.url
          ? await fetch(file.url).then((r) => r.bytes())
          : Uint8Array.from(atob(file.base64!), (c) => c.charCodeAt(0));
        data.push({ name: file.name, bytes });
      }
      const out = await window.tryConvertByTraversing(data, from, to, { settings });
      if (!out) return null;
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs inside the page
      const b64 = (bytes: Uint8Array) => {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      };
      return {
        path: out.path.map((n) => `${n.handler.name}:${n.format.format}`),
        files: out.files.map((f) => ({ name: f.name, base64: b64(f.bytes) })),
      };
    },
    files,
    { format: from, handler: dummyHandler },
    { format: to, handler: dummyHandler },
    settings,
  );
  if (!result) throw new Error(`No route from ${from.format} to ${to.format} worked.`);
  return {
    path: result.path,
    files: result.files.map((f) => ({
      name: f.name,
      bytes: new Uint8Array(Buffer.from(f.base64, "base64")),
    })),
  };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const pngSize = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
};

test("frame a screenshot as a Win98, glass and macOS window", async () => {
  const png = await format("png", "image/png");
  const framed = await format("framed");
  for (const frameStyle of ["card", "Win98 window", "liquid glass window", "macOS window"]) {
    const { files, path } = await convert(["colors_50x50.png"], png, framed, {
      frameStyle,
      background: "mint",
    });
    expect(path.at(-1)).toBe("frame:framed");
    const [w, h] = pngSize(files[0].bytes);
    expect(w).toBeGreaterThan(50);
    expect(h).toBeGreaterThan(frameStyle === "card" ? 50 : 70);
  }
}, 60_000);

test("remove metadata from a JPEG without re-encoding it", async () => {
  const jpeg = await format("jpeg", "image/jpeg");
  const clean = await format("clean-jpeg");
  const { files } = await convert(["colors_50x50.png"], await format("png", "image/png"), jpeg);
  const { files: out, path } = await convert(
    [{ name: "a.jpg", bytes: files[0].bytes }],
    jpeg,
    clean,
  );
  expect(path).toEqual(["dummy:jpeg", "stripMetadata:clean-jpeg"]);
  expect(out[0].name).toBe("a-clean.jpg");
  expect([out[0].bytes[0], out[0].bytes[1]]).toEqual([0xff, 0xd8]);
}, 60_000);

test("encrypt with age and open it again", async () => {
  const age = await format("age");
  const opened = await format("age-opened");
  const md = await format("markdown");
  const { files } = await convert([{ name: "note.md", bytes: "# secret note" }], md, age, {
    passphrase: "hunter2",
  });
  expect(files[0].name).toBe("note.md.age");
  expect(text(files[0].bytes.subarray(0, 21))).toBe("age-encryption.org/v1");
  const { files: back } = await convert([files[0]], age, opened, { passphrase: "hunter2" });
  expect(back[0]).toEqual({ name: "note.md", bytes: new TextEncoder().encode("# secret note") });
}, 60_000);

const NOTE =
  "# Plan\n\n## Home\n- [ ] call mum 📅 2026-11-20\n- [/] paint\n\n---\n\n## Work\n- [x] ship it\n";

test("a note as slides, in HTML and in PDF", async () => {
  const md = await format("markdown");
  const { files } = await convert([{ name: "plan.md", bytes: NOTE }], md, await format("slides"), {
    look: "Win98",
  });
  expect(text(files[0].bytes).match(/class="slide panel"/g)!.length).toBe(2);
  const { files: pdf } = await convert(
    [{ name: "plan.md", bytes: NOTE }],
    md,
    await format("slides-pdf"),
  );
  expect(text(pdf[0].bytes.subarray(0, 5))).toBe("%PDF-");
}, 60_000);

test("a textarea-plus note as a board", async () => {
  const { files } = await convert(
    [{ name: "plan.md", bytes: NOTE }],
    await format("markdown"),
    await format("kanban"),
  );
  const html = text(files[0].bytes);
  expect(html.match(/class="card panel"/g)!.length).toBe(3);
  expect(files[0].name).toBe("plan-board.html");
}, 60_000);

test("a theme pack from the colours of a picture", async () => {
  const { files } = await convert(
    ["colors_50x50.png"],
    await format("png", "image/png"),
    await format("looks"),
  );
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(files[0].bytes);
  expect(Object.keys(zip.files)).toContain("css/glass.css");
  expect(await zip.file("textarea-theme.txt")!.async("string")).toContain("textarea-theme:");
}, 60_000);

test("an MHTML page as one HTML file", async () => {
  const mhtml = [
    'Content-Type: multipart/related; boundary="B"',
    "",
    "--B",
    "Content-Type: text/html",
    "Content-Location: https://example.org/",
    "",
    '<html><body><img src="p.png"><script>alert(1)</script></body></html>',
    "--B",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-Location: https://example.org/p.png",
    "",
    "iVBORw==",
    "--B--",
  ].join("\r\n");
  const { files } = await convert(
    [{ name: "page.mhtml", bytes: mhtml }],
    await format("mhtml"),
    await format("archived-page"),
  );
  const html = text(files[0].bytes);
  expect(html).toContain("data:image/png;base64,iVBORw==");
  expect(html).not.toContain("<script");
}, 60_000);

test("subset a font for the web and make a specimen", async () => {
  const path = "built/typst-assets/files/fonts/DejaVuSansMono.ttf";
  if (!(await Bun.file(path).exists())) return;
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const ttf = await format("ttf");
  const { files } = await convert(
    [{ name: "mono.ttf", bytes }],
    ttf,
    await format("woff2-subset"),
    { subsetText: "Hello" },
  );
  expect(text(files[0].bytes.subarray(0, 4))).toBe("wOF2");
  expect(files[0].bytes.length).toBeLessThan(bytes.length / 20);
  const { files: sheet } = await convert(
    [{ name: "mono.ttf", bytes }],
    ttf,
    await format("font-specimen"),
  );
  expect(text(sheet[0].bytes)).toContain("DejaVu Sans Mono");
}, 60_000);

test("redact and sign a PDF", async () => {
  const pdf = await format("pdf", "application/pdf");
  const md = await format("markdown");
  const { files } = await convert(
    [{ name: "letter.md", bytes: "# Letter\n\nDear Jan Jansen, hello." }],
    md,
    await format("slides-pdf"),
  );
  const { files: redacted } = await convert([files[0]], pdf, await format("pdf-redacted"), {
    redact: "Jan Jansen",
  });
  expect(redacted[0].name).toBe("letter-slides-redacted.pdf");
  const { files: signed } = await convert([files[0]], pdf, await format("pdf-signed"), {
    signature: "J. Jansen",
  });
  expect(text(signed[0].bytes.subarray(0, 5))).toBe("%PDF-");
}, 60_000);

test("a picture of a chair as Gaussian splats and as a mesh to print", async () => {
  const png = await format("png", "image/png");
  const { files: ply } = await convert(["abo-chair.png"], png, await format("splats-3d"));
  const header = new TextDecoder("latin1").decode(ply[0].bytes.subarray(0, 600));
  // the Python CLI keeps 254 Gaussians for this picture; the browser letterboxes a 128 px
  // picture without resampling, so it should see the same pixels and keep the same cells
  const count = Number(/element vertex (\d+)/.exec(header)![1]);
  expect(Math.abs(count - 254)).toBeLessThanOrEqual(5);
  const { files: stl } = await convert(["abo-chair.png"], png, await format("mesh-3d-stl"));
  const triangles = new DataView(stl[0].bytes.buffer, stl[0].bytes.byteOffset).getUint32(80, true);
  expect(triangles).toBeGreaterThan(1000);
  expect(stl[0].bytes.length).toBe(84 + 50 * triangles);
  const { files: glb } = await convert(["abo-chair.png"], png, await format("mesh-3d-glb"));
  expect(text(glb[0].bytes.subarray(0, 4))).toBe("glTF");
}, 120_000);
