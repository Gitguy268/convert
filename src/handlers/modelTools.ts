import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { changeExt, encode, stripExt } from "src/common/index.ts";
import type { ModelId } from "src/localModels/store.ts";

/**
 * The tools that run a language model in the browser (src/localModels): Mermaid from a
 * picture of a diagram, receipts to a spreadsheet, and speech to subtitles. The page asks for
 * the model before the conversion starts (src/ui/components/ModelDialog), so these only read it.
 * They run on the page, not in a worker: wllama starts workers of its own.
 */

export const MERMAID_FROM_IMAGE = new FormatDefinition(
  "Mermaid diagram, read from the picture (local AI)",
  "mermaid-from-image",
  "mmd",
  "text/vnd.mermaid",
  [Category.TEXT, Category.CODE],
);
export const RECEIPT_CSV = new FormatDefinition(
  "Expenses from receipts (CSV, local AI)",
  "receipt-csv",
  "csv",
  "text/csv",
  [Category.DATA, Category.SPREADSHEET],
);
export const RECEIPT_JSON = new FormatDefinition(
  "Receipt as JSON (CORD fields, local AI)",
  "receipt-json",
  "json",
  "application/json",
  Category.DATA,
);
export const TRANSCRIPT_SRT = new FormatDefinition(
  "Subtitles from the speech (SRT, local AI)",
  "transcript-srt",
  "srt",
  "application/x-subrip",
  Category.TEXT,
);
export const TRANSCRIPT_VTT = new FormatDefinition(
  "Subtitles from the speech (WebVTT, local AI)",
  "transcript-vtt",
  "vtt",
  "text/vtt",
  Category.TEXT,
);

/** Which model each output needs. The conversion page reads this to ask for it first. */
export const MODEL_FOR_FORMAT: Record<string, ModelId> = {
  "mermaid-from-image": "mermaid",
  "receipt-csv": "receipt",
  "receipt-json": "receipt",
  "transcript-srt": "speech",
  "transcript-vtt": "speech",
};

const PICTURES = [
  Formats.PNG.builder("png").from(),
  Formats.JPEG.builder("jpeg").from(),
  Formats.WEBP.builder("webp").from(),
];

// ---------------------------------------------------------------------------- Mermaid

const DIAGRAM_START =
  /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|mindmap|journey|gitGraph|timeline|quadrantChart|requirementDiagram|C4Context|block-beta|sankey-beta|xychart-beta|architecture-beta)\b/m;

/**
 * The Mermaid code in a model's answer: what is in a code fence, or from the line that starts a
 * diagram. A last line the model left half-written (an arrow to nothing) is dropped.
 */
export function extractMermaid(answer: string): string {
  const fenced = /```(?:mermaid)?\s*\n([\s\S]*?)(?:```|$)/.exec(answer)?.[1];
  let code = fenced ?? answer;
  const start = DIAGRAM_START.exec(code);
  if (start) code = code.slice(start.index);
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  // the model indents everything under its own sentence; the diagram keeps its own indent
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  const out = lines
    .map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
    .filter((l) => l.trim());
  while (out.length > 1 && /(-->|---|-\.->|==>|->>|-->>|:)\s*$/.test(out.at(-1)!)) out.pop();
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------- receipts

/** The prompt the CORD LoRA was trained and tested with (its model card). */
export const RECEIPT_PROMPT =
  "Extract this receipt as JSON using the CORD schema: menu, sub_total, total. Use CORD field names such as nm, cnt, price, subtotal_price, tax_price, and total_price. Preserve printed values as strings, omit absent fields, and return only JSON.";

export interface Receipt {
  items: { name: string; count?: string; unitPrice?: string; price?: string }[];
  totals: Record<string, string>;
}

const ITEM_NAME = new Set(["nm", "menu", "name", "item"]);
/** The totals of CORD, in the order a receipt prints them. */
const TOTAL_KEYS = [
  "subtotal_price",
  "discount_price",
  "service_price",
  "tax_price",
  "etc_price",
  "total_price",
  "cash_price",
  "change_price",
  "creditcard_price",
  "emoney_price",
  "menuqty_cnt",
];
/** The spellings the model also uses for them. */
const KEY_ALIASES: Record<string, string> = {
  total: "total_price",
  totalprice: "total_price",
  subtotal: "subtotal_price",
  subtotalprice: "subtotal_price",
  taxprice: "tax_price",
  tax: "tax_price",
  cashprice: "cash_price",
  changeprice: "change_price",
  etcprice: "etc_price",
  discountprice: "discount_price",
  serviceprice: "service_price",
  creditcardprice: "creditcard_price",
  emoneyprice: "emoney_price",
  unitprice: "unit_price",
};

/**
 * A receipt from the model's answer. The answer is CORD-shaped JSON that is often broken (the
 * model card says so): full-width colons, curly quotes, keys repeated, brackets missing. So it
 * is read as a run of "key": "value" pairs, in order, rather than parsed.
 */
export function parseReceipt(answer: string): Receipt {
  const items: Receipt["items"] = [];
  const totals: Record<string, string> = {};
  const pairs = answer.matchAll(
    /["“]?([A-Za-z_]+)[^"“”:：,{}[\]\n]*["”]?\s*[:：]\s*["“]([^"“”\n]*)["”]/g,
  );
  for (const [, rawKey, rawValue] of pairs) {
    const key = KEY_ALIASES[rawKey.toLowerCase()] ?? rawKey.toLowerCase();
    const value = rawValue.trim();
    if (ITEM_NAME.has(key)) items.push({ name: value });
    else if (TOTAL_KEYS.includes(key)) totals[key] ??= value;
    else {
      const item = items.at(-1);
      if (!item) continue;
      if (key === "cnt") item.count ??= value;
      else if (key === "unit_price") item.unitPrice ??= value;
      else if (key === "price") item.price ??= value;
    }
  }
  return { items, totals };
}

const csvCell = (value: string | undefined) => {
  const text = value ?? "";
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Receipts as one spreadsheet: a row per item, then the totals of that receipt. */
export function receiptsCsv(receipts: { name: string; receipt: Receipt }[]): string {
  const rows = [["receipt", "item", "count", "unit price", "price"]];
  for (const { name, receipt } of receipts) {
    for (const item of receipt.items)
      rows.push([name, item.name, item.count ?? "", item.unitPrice ?? "", item.price ?? ""]);
    for (const [key, value] of Object.entries(receipt.totals)) {
      rows.push([
        name,
        key
          .replaceAll("_", " ")
          .replace(/\bprice\b/, "")
          .trim(),
        "",
        "",
        value,
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------- speech

export const SAMPLE_RATE = 16000;

/** Decodes the sound of a song or a video into mono at 16 kHz, what Qwen3-ASR hears. */
async function decodeAudio(bytes: Uint8Array): Promise<Float32Array> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(bytes.slice().buffer);
    const frames = Math.ceil(decoded.duration * SAMPLE_RATE);
    const offline = new OfflineAudioContext(1, Math.max(1, frames), SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return (await offline.startRendering()).getChannelData(0);
  } catch (error) {
    throw new Error(
      "The browser could not decode the sound of this file. Convert it to WAV or MP3 first.",
      { cause: error },
    );
  } finally {
    await context.close();
  }
}

/**
 * Where people speak: stretches of audio louder than the quiet parts of the file, joined across
 * short pauses and cut at the quietest moment when they run longer than `max` seconds. Each
 * becomes one subtitle, since the model gives no timings of its own.
 */
export function speechSegments(
  samples: Float32Array,
  rate = SAMPLE_RATE,
  max = 15,
): [number, number][] {
  const frame = Math.round(rate * 0.03);
  const count = Math.floor(samples.length / frame);
  if (!count) return [];
  const energy = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i];
    energy[f] = 10 * Math.log10(sum / frame + 1e-10);
  }
  const sorted = energy.toSorted((a, b) => a - b);
  const floor = sorted[Math.floor(count * 0.1)];
  const peak = sorted[Math.floor(count * 0.98)];
  if (peak < -60) return []; // silence, or almost
  // without quiet parts to tell speech from (talk that never stops) all of it counts
  const threshold = peak - floor > 15 ? Math.max(floor + 10, peak - 35) : -Infinity;
  const voiced = Array.from(energy, (e) => e > threshold);
  // a pause shorter than 0.4 s is a breath, not the end of a sentence
  const gap = Math.round(0.4 / 0.03);
  const segments: [number, number][] = [];
  let start = -1;
  let silent = 0;
  for (let f = 0; f <= count; f++) {
    if (f < count && voiced[f]) {
      if (start < 0) start = f;
      silent = 0;
    } else if (start >= 0 && (++silent > gap || f === count)) {
      segments.push([start, f - silent + 1]);
      start = -1;
      silent = 0;
    }
  }
  const out: [number, number][] = [];
  const maxFrames = Math.round(max / 0.03);
  for (let [a, b] of segments) {
    while (b - a > maxFrames) {
      // the quietest frame in the last third of the allowed length
      let cut = a + maxFrames;
      for (let f = a + Math.round(maxFrames * 0.66); f < a + maxFrames; f++)
        if (energy[f] < energy[cut]) cut = f;
      out.push([a, cut]);
      a = cut;
    }
    if (b - a >= Math.round(0.3 / 0.03)) out.push([a, b]);
  }
  const pad = 0.15;
  const duration = samples.length / rate;
  return out.map(([a, b]) => [Math.max(0, a * 0.03 - pad), Math.min(duration, b * 0.03 + pad)]);
}

/** 16-bit mono WAV, what wllama's audio input takes. */
export function encodeWav(samples: Float32Array, rate = SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  }
  return out;
}

/** Qwen3-ASR starts its answer with the language it heard: `language English<asr_text>`. */
export const cleanTranscript = (text: string) =>
  text
    .replace(/^.*?<asr_text>/s, "")
    .replace(/<\/?asr_text>/g, "")
    .trim();

export interface Cue {
  start: number;
  end: number;
  text: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

const stamp = (seconds: number, separator: string) => {
  const ms = Math.round(seconds * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
};

/** A subtitle's text in at most two lines of about 42 characters, as subtitles are set. */
export function wrapCue(text: string, width = 42): string {
  if (text.length <= width) return text;
  const words = text.split(/\s+/);
  let best = text;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const score = Math.max(a.length, b.length);
    if (score < bestScore) [best, bestScore] = [`${a}\n${b}`, score];
  }
  return best;
}

export const toSrt = (cues: Cue[]) =>
  cues
    .map(
      (c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${wrapCue(c.text)}\n`,
    )
    .join("\n");
export const toVtt = (cues: Cue[]) =>
  "WEBVTT\n\n" +
  cues
    .map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${wrapCue(c.text)}\n`)
    .join("\n");

/** 00:01:02,500 (SRT), 00:01:02.500 or 01:02.500 (WebVTT) in seconds. */
const cueTime = (stamp: string) =>
  stamp
    .trim()
    .replace(",", ".")
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);

/** Cues back from SRT or WebVTT, for the subtitle editor. */
export function parseCues(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    cues.push({
      start: cueTime(a),
      end: cueTime(b.trim().split(/\s/)[0]),
      text: lines
        .slice(at + 1)
        .join("\n")
        .trim(),
    });
  }
  return cues;
}

/** The three model tools. */
class modelToolsHandler implements FormatHandler {
  public readonly name = "modelTools";
  public supportedFormats = [
    ...PICTURES,
    Formats.MP3.builder("mp3").from(),
    Formats.WAV.builder("wav").from(),
    Formats.M4A.builder("m4a").from(),
    Formats.OGG.builder("ogg").from(),
    Formats.FLAC.builder("flac").from(),
    Formats.MP4.builder("mp4").from(),
    Formats.WEBM.builder("webm").from(),
    Formats.MOV.builder("mov").from(),
    MERMAID_FROM_IMAGE.builder("mmd").to(),
    RECEIPT_CSV.builder("csv").to(),
    RECEIPT_JSON.builder("json").to(),
    TRANSCRIPT_SRT.builder("srt").to(),
    TRANSCRIPT_VTT.builder("vtt").to(),
  ];
  public ready = false;
  public offload = false; // wllama starts its own workers, and the sound is decoded by the page
  public abortable = true;

  async init() {
    // nothing is loaded here: the format cache build calls this for every handler
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const { ask } = await import("src/localModels/engine.ts");
    const progress = (message: string) => ctx?.progress(message, 0);
    const isPicture = PICTURES.some((f) => f.mime === inputFormat.mime);
    const format = outputFormat.format;

    if (format === "mermaid-from-image") {
      if (!isPicture) throw new TypeError("Mermaid is read from pictures.");
      const outputs: FileData[] = [];
      for (const file of inputFiles) {
        ctx?.progress(`Reading the diagram in ${file.name}...`, 0.3);
        const answer = await ask(
          "mermaid",
          [
            {
              role: "user",
              content: [
                { type: "image", data: file.bytes },
                { type: "text", text: "Convert this diagram into Mermaid code." },
              ],
            },
          ],
          { signal: ctx?.signal, onProgress: progress, maxTokens: 1500 },
        );
        const code = extractMermaid(answer);
        ctx?.log(`${file.name}: ${code.split("\n").length - 1} lines of Mermaid.`);
        outputs.push({ name: changeExt(file.name, "mmd"), bytes: encode(code) });
      }
      return outputs;
    }

    if (format === "receipt-csv" || format === "receipt-json") {
      if (!isPicture) throw new TypeError("Receipts are read from pictures.");
      const receipts: { name: string; receipt: Receipt; answer: string }[] = [];
      for (const [i, file] of inputFiles.entries()) {
        ctx?.progress(`Reading receipt ${i + 1} of ${inputFiles.length}...`, i / inputFiles.length);
        const answer = await ask(
          "receipt",
          [
            {
              role: "user",
              content: [
                { type: "image", data: file.bytes },
                { type: "text", text: RECEIPT_PROMPT },
              ],
            },
          ],
          { signal: ctx?.signal, onProgress: progress, penalties: true },
        );
        const receipt = parseReceipt(answer);
        if (!receipt.items.length && !Object.keys(receipt.totals).length) {
          ctx?.log(
            `${file.name}: no items or totals could be read. The model said: ${answer.slice(0, 300)}`,
          );
        }
        receipts.push({ name: file.name, receipt, answer });
      }
      if (format === "receipt-json") {
        return receipts.map(({ name, receipt, answer }) => ({
          name: changeExt(name, "json", "-receipt"),
          bytes: encode(JSON.stringify({ ...receipt, modelAnswer: answer }, null, 2) + "\n"),
        }));
      }
      const name =
        inputFiles.length > 1
          ? `${stripExt(inputFiles[0].name)}-and-more-expenses.csv`
          : changeExt(inputFiles[0].name, "csv", "-expenses");
      return [{ name, bytes: encode(receiptsCsv(receipts)) }];
    }

    // speech to subtitles
    const outputs: FileData[] = [];
    for (const file of inputFiles) {
      ctx?.progress(`Listening to ${file.name}...`, 0.05);
      const samples = await decodeAudio(file.bytes);
      const segments = speechSegments(samples);
      if (!segments.length) throw new Error(`No speech was found in ${file.name}.`);
      const cues: Cue[] = [];
      for (const [i, [start, end]] of segments.entries()) {
        ctx?.throwIfAborted();
        ctx?.progress(
          `Transcribing ${file.name}: part ${i + 1} of ${segments.length}`,
          i / segments.length,
        );
        const part = samples.subarray(
          Math.floor(start * SAMPLE_RATE),
          Math.ceil(end * SAMPLE_RATE),
        );
        const answer = await ask(
          "speech",
          [{ role: "user", content: [{ type: "audio", data: encodeWav(part) }] }],
          {
            signal: ctx?.signal,
            onProgress: progress,
            maxTokens: 400,
          },
        );
        const text = cleanTranscript(answer);
        if (text) cues.push({ start, end, text });
      }
      const vtt = format === "transcript-vtt";
      outputs.push({
        name: changeExt(file.name, vtt ? "vtt" : "srt"),
        bytes: encode(vtt ? toVtt(cues) : toSrt(cues)),
      });
    }
    return outputs;
  }
}

export default modelToolsHandler;
