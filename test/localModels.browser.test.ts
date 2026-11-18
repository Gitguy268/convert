import { afterAll, expect, test } from "bun:test";
import puppeteer from "puppeteer";
import { preview } from "vite";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The three model tools end to end, the way a reader uses them: drop a file, pick the tool,
 * let the model dialog download the model, and read the file that comes out.
 *
 * Gated, because the models are 0.75 to 1.8 GB: set MODEL_E2E=1 and MODEL_DIR to a folder
 * with the GGUF files of src/localModels/models.json, and MEDIA_DIR to one with receipt.jpg
 * (xiaomi-research/Xiaomi-OCR-0's example), jfk.wav (whisper.cpp's sample) and flowchart.png.
 * The files are served by the preview server instead of Hugging Face, but go through the same
 * download, the same check of every 64 MiB and the same OPFS store. Needs WebGPU, so it runs
 * Chromium with --enable-unsafe-webgpu --use-angle=metal (macOS).
 */

const enabled = process.env.MODEL_E2E === "1" && !!process.env.MODEL_DIR && !!process.env.MEDIA_DIR;
const run = enabled ? test : test.skip;
const MODEL_DIR = process.env.MODEL_DIR ?? "";
const MEDIA_DIR = process.env.MEDIA_DIR ?? "";
const work = join(import.meta.dir, "..", ".cache", "model-e2e");

let server: Awaited<ReturnType<typeof preview>> | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

async function start() {
  if (browser) return browser;
  server = await preview({
    logLevel: "silent",
    preview: { port: 0 },
    plugins: [
      {
        name: "test-models",
        configurePreviewServer(s) {
          s.middlewares.use("/test-models", (req, res, next) => {
            const file = Bun.file(
              join(MODEL_DIR, decodeURIComponent(req.url!.slice(1)).replaceAll("..", "")),
            );
            file.exists().then((ok) => {
              if (!ok) return next();
              res.setHeader("Content-Length", String(file.size));
              res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
              // streamed: a whole GGUF in memory would be 1 GB
              const reader = file.stream().getReader();
              const pump = (): Promise<void> =>
                reader.read().then(({ value, done }) => {
                  if (done) return void res.end();
                  if (!res.write(value))
                    return new Promise<void>((r) => res.once("drain", () => r(pump())));
                  return pump();
                });
              void pump();
            });
          });
        },
      },
    ],
  });
  rmSync(join(work, "downloads"), { recursive: true, force: true });
  mkdirSync(join(work, "downloads"), { recursive: true });
  browser = await puppeteer.launch({
    headless: true,
    // a profile of its own, so a model downloaded once stays for the next run
    userDataDir: join(work, "profile"),
    args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--no-sandbox"],
    protocolTimeout: 20 * 60_000,
  });
  return browser;
}

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, 60_000);

/** Drops a file on the app, picks a tool by its label, converts, and returns the download. */
async function useTool(file: string, tool: string, expectName: RegExp) {
  const page = await (await start()).newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: join(work, "downloads"),
  });
  await page.evaluateOnNewDocument(() => {
    (globalThis as { __LOCAL_MODELS_BASE__?: string }).__LOCAL_MODELS_BASE__ = "/test-models/";
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on(
    "console",
    (m) => /error/i.test(m.type()) && console.log("[console]", m.text().slice(0, 300)),
  );
  await Promise.all([
    new Promise((resolve) =>
      page.on("console", (m) => m.text() === "Built initial format list." && resolve(null)),
    ),
    page.goto(server!.resolvedUrls!.local[0]),
  ]);
  const input = await page.waitForSelector("#uploadFile:not([disabled])", { timeout: 120_000 });
  await input!.uploadFile(join(MEDIA_DIR, file));
  const chip = await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label),
    { timeout: 60_000 },
    tool,
  );
  // clicked in the DOM: the floating dock can cover the chip, and a mouse click there would
  // land on the dock's "remove file" button
  await chip.evaluate((el) => (el as HTMLElement).click());
  const convert = await page
    .waitForSelector(".conversion-primary-action", { timeout: 10_000 })
    .catch(async (e) => {
      await page.screenshot({ path: join(work, "stuck.png") });
      console.log("[stuck]", (await page.evaluate(() => document.body.innerText)).slice(0, 1500));
      throw e;
    });
  await convert!.evaluate((el) => (el as HTMLElement).click());
  // the model dialog, unless the model is already in this browser
  const popupText = () =>
    page.evaluate(
      () => (document.querySelector("#popup[open]") as HTMLElement | null)?.innerText ?? "",
    );
  await page.waitForFunction(() => !!document.querySelector("#popup[open]"), { timeout: 120_000 });
  if ((await popupText()).includes("runs an AI model")) {
    await page.evaluate(() =>
      (document.querySelector("#popup .model-dialog-primary") as HTMLElement).click(),
    );
  }
  await page.waitForFunction(
    () =>
      /Conversion (complete|failed|error)|Converted, with failures|did not arrive|could not/.test(
        (document.querySelector("#popup[open]") as HTMLElement | null)?.innerText ?? "",
      ),
    { timeout: 15 * 60_000, polling: 1000 },
  );
  const title = await popupText();
  expect(title).toContain("Conversion complete!");
  for (let i = 0; i < 50; i++) {
    // "._" files are macOS's AppleDouble sidecars on a FAT or exFAT drive
    const found = readdirSync(join(work, "downloads")).find(
      (n) => expectName.test(n) && !n.startsWith("._") && !n.endsWith(".crdownload"),
    );
    if (found) {
      await page.close();
      return {
        name: found,
        text: readFileSync(join(work, "downloads", found), "utf8"),
        popup: title,
      };
    }
    await Bun.sleep(200);
  }
  throw new Error(`Nothing named like ${expectName} was downloaded.`);
}

run(
  "Receipt to CSV reads the items and the total",
  async () => {
    const { text } = await useTool("receipt.jpg", "Receipt to CSV (AI)", /receipt-expenses\.csv$/);
    console.log(text);
    expect(text.split("\r\n")[0]).toBe("receipt,item,count,unit price,price");
    expect(text).toContain("CLOTH PEG");
    expect(text).toMatch(/total.*5\.90/);
  },
  20 * 60_000,
);

run(
  "Subtitles from speech give the sentence with timings",
  async () => {
    const { text } = await useTool("jfk.wav", "Subtitles (AI)", /jfk\.srt$/);
    console.log(text);
    expect(text).toMatch(/^1\n00:00:0\d,\d{3} --> 00:00:\d\d,\d{3}\n/);
    // the words of all cues together, whatever the pauses cut them into
    const words = text
      .split("\n")
      .filter((line) => line && !/^\d+$/.test(line) && !line.includes("-->"))
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z ]/g, "");
    expect(words).toContain("ask not what your country can do for you");
  },
  20 * 60_000,
);

run(
  "Diagram to Mermaid reads a flowchart and opens it in the editor",
  async () => {
    const { text, popup } = await useTool(
      "flowchart.png",
      "Diagram to Mermaid (AI)",
      /flowchart\.mmd$/,
    );
    console.log(text);
    expect(text).toMatch(/^(flowchart|graph) /);
    expect(text).toMatch(/Start/);
    expect(popup).toContain("in the editor");
  },
  20 * 60_000,
);
