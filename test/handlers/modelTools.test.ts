import { expect, test } from "bun:test";
import {
  cleanTranscript,
  encodeWav,
  extractMermaid,
  parseCues,
  parseReceipt,
  receiptsCsv,
  speechSegments,
  toSrt,
  toVtt,
  wrapCue,
} from "../../src/handlers/modelTools.ts";

test("extractMermaid keeps the diagram and drops the chatter and a half-written last line", () => {
  // what minicpm-mermaid answered for a three-box flowchart (2026-11-18 spike)
  const answer =
    "Here is the Mermaid diagram for the process flow:\n    flowchart TD\n    Start --> ReadFile\n    ReadFile --> Convert\n    Convert --> End\n    End -->";
  expect(extractMermaid(answer)).toBe(
    "flowchart TD\nStart --> ReadFile\nReadFile --> Convert\nConvert --> End\n",
  );
  expect(extractMermaid("Sure!\n```mermaid\ngraph LR\n  A --> B\n```\nDone.")).toBe(
    "graph LR\n  A --> B\n",
  );
});

test("parseReceipt reads the broken JSON the CORD LoRA writes", () => {
  // Xiaomi-OCR-0 + CORD LoRA on the base repo's receipt.jpg, with repetition held back
  const answer =
    '{"menu：“CLOTH PEG E-140","num":"9555112901406","unitprice":"5.90","cnt":"1 X","price":"5.90*S","sub台号":"WA36 - 6/60"},"total</think>": {"total_price":"RM 5.90","cashprice":"RM 5.90","taxprice":"0.33","etcprice":"5.57","menuqty_cnt":"1"}}';
  const receipt = parseReceipt(answer);
  expect(receipt.items).toEqual([
    { name: "CLOTH PEG E-140", unitPrice: "5.90", count: "1 X", price: "5.90*S" },
  ]);
  expect(receipt.totals).toEqual({
    total_price: "RM 5.90",
    cash_price: "RM 5.90",
    tax_price: "0.33",
    etc_price: "5.57",
    menuqty_cnt: "1",
  });
  const csv = receiptsCsv([{ name: "r.jpg", receipt }]);
  expect(csv.split("\r\n")[0]).toBe("receipt,item,count,unit price,price");
  expect(csv).toContain("r.jpg,CLOTH PEG E-140,1 X,5.90,5.90*S");
  expect(csv).toContain("r.jpg,total,,,RM 5.90");
  expect(
    parseReceipt(
      '{"menu":[{"nm":"Tea, hot","cnt":"2","price":"6,000"}],"total":{"total_price":"6,000"}}',
    ),
  ).toEqual({
    items: [{ name: "Tea, hot", count: "2", price: "6,000" }],
    totals: { total_price: "6,000" },
  });
  expect(
    receiptsCsv([{ name: "a", receipt: { items: [{ name: 'say "hi", ok' }], totals: {} } }]),
  ).toContain('"say ""hi"", ok"');
});

test("speechSegments finds the speech between silences and caps the length", () => {
  const rate = 16000;
  const samples = new Float32Array(rate * 10);
  const tone = (from: number, to: number) => {
    for (let i = from * rate; i < to * rate; i++) samples[i] = 0.3 * Math.sin(i / 5);
  };
  tone(1, 3);
  tone(3.2, 4); // a breath: the same segment
  tone(6, 8);
  for (let i = 0; i < samples.length; i++) samples[i] += (Math.random() - 0.5) * 0.002;
  const segments = speechSegments(samples, rate);
  expect(segments.length).toBe(2);
  expect(segments[0][0]).toBeCloseTo(0.85, 1);
  expect(segments[0][1]).toBeCloseTo(4.15, 1);
  expect(segments[1][0]).toBeCloseTo(5.85, 1);

  const long = new Float32Array(rate * 40).map(
    (_, i) => 0.3 * Math.sin(i / 5) * (1 + 0.2 * Math.sin(i / 8000)),
  );
  const parts = speechSegments(long, rate, 15);
  expect(parts.length).toBe(3);
  expect(Math.max(...parts.map(([a, b]) => b - a))).toBeLessThanOrEqual(15.31);
});

test("subtitles: SRT and WebVTT out and back, two balanced lines, Qwen3-ASR's prefix removed", () => {
  expect(cleanTranscript("language English<asr_text>And so, my fellow Americans.")).toBe(
    "And so, my fellow Americans.",
  );
  expect(wrapCue("short")).toBe("short");
  expect(wrapCue("ask not what your country can do for you; ask what you can do")).toBe(
    "ask not what your country can\ndo for you; ask what you can do",
  );
  const cues = [
    { start: 0.25, end: 2.5, text: "Hello there." },
    { start: 3661.001, end: 3662, text: "An hour later." },
  ];
  const srt = toSrt(cues);
  expect(srt).toContain("1\n00:00:00,250 --> 00:00:02,500\nHello there.\n");
  expect(srt).toContain("01:01:01,001 --> 01:01:02,000");
  expect(parseCues(srt)).toEqual(cues);
  expect(toVtt(cues).startsWith("WEBVTT\n\n00:00:00.250 --> 00:00:02.500")).toBe(true);
  expect(parseCues(toVtt(cues))).toEqual(cues);
  expect(parseCues("WEBVTT\n\n01:02.500 --> 01:04.000 align:start\nShort stamps")).toEqual([
    { start: 62.5, end: 64, text: "Short stamps" },
  ]);
});

test("encodeWav writes 16-bit mono PCM", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]));
  const view = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(view.getUint32(24, true)).toBe(16000);
  expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([
    0, 32767, -32767,
  ]);
});
