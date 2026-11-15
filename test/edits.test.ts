import { expect, test } from "bun:test";
import type { HandlerDefinition } from "../src/FormatHandler.js";
import Formats from "../src/Formats.js";
import type { HandlerName } from "../src/handlers/index.js";
import {
  altersContent,
  compressorsFor,
  ffmpegAudioFilter,
  ffmpegCopyArgs,
  ffmpegScaleFilter,
  ffmpegSpeedFilter,
  ffmpegTrimArgs,
  tidyEdits,
} from "../src/edits.js";
import { Settings, isValidOption, type OptionSpec } from "../src/Settings.js";

const valid = (key: keyof typeof Settings, value: unknown) =>
  isValidOption(Settings[key] as OptionSpec, value);

test("the fork's settings check their values the way the old form did", () => {
  expect(valid("pages", " 2-5,8 ")).toBe(true);
  for (const pages of ["", "a", "2-", "1,,2"]) expect(valid("pages", pages)).toBe(false);
  expect(valid("rotate", "90")).toBe(true);
  for (const rotate of ["45", "360", 90]) expect(valid("rotate", rotate)).toBe(false);
  // mupdf takes its save options as one "key=value,key=value" string
  expect(valid("protect", "a b")).toBe(true);
  expect(valid("protect", "a,b")).toBe(false);
  expect(valid("password", "a=b")).toBe(false);
  expect(valid("colors", 64)).toBe(true);
  for (const colors of [1, 300, 63.5]) expect(valid("colors", colors)).toBe(false);
  expect(valid("speed", 4)).toBe(true);
  expect(valid("speed", 10)).toBe(false);
});

test("tidyEdits drops combinations that cannot work together", () => {
  expect(tidyEdits({ start: 5, end: 3 })).toEqual({ start: 5 });
  expect(tidyEdits({ start: 5, end: 9 })).toEqual({ start: 5, end: 9 });
  // the normal speed is no edit at all, and filters undo a stream copy
  expect(tidyEdits({ speed: 1, copyStreams: true })).toEqual({ copyStreams: true });
  expect(tidyEdits({ normalize: true, copyStreams: true })).toEqual({ normalize: true });
  expect(tidyEdits({ pages: "  " })).toEqual({});
  expect(tidyEdits({ protect: " a b " })).toEqual({ protect: "a b" });
});

test("tidyEdits does not re-encode a PDF's images just because pages were turned or selected", () => {
  // quality 70 is the "Compress" default, the user set none
  expect(tidyEdits({ quality: 70 }, {})).toEqual({ quality: 70 });
  expect(tidyEdits({ quality: 70, rotate: "90" }, { rotate: "90" })).toEqual({ rotate: "90" });
  expect(tidyEdits({ quality: 70, protect: "x" }, { protect: "x" })).toEqual({ protect: "x" });
  expect(tidyEdits({ quality: 50, pages: "1" })).toEqual({ quality: 50, pages: "1" });
});

test("ffmpegScaleFilter only exists when a size is set, and never enlarges", () => {
  expect(ffmpegScaleFilter({})).toBeUndefined();
  expect(ffmpegScaleFilter({ maxSize: 640 })).toContain("min(iw,640)");
});

test("ffmpegSpeedFilter cuts the video as the audio chain does, then changes its pace", () => {
  expect(ffmpegSpeedFilter({})).toBeUndefined();
  expect(ffmpegSpeedFilter({ start: 2 })).toBeUndefined();
  expect(ffmpegSpeedFilter({ speed: 2 })).toBe("setpts=(PTS-STARTPTS)/2");
  expect(ffmpegSpeedFilter({ speed: 0.5, start: 1, end: 3 })).toBe(
    "trim=start=1:end=3,setpts=(PTS-STARTPTS)/0.5",
  );
  // the audio half of the same change
  expect(ffmpegAudioFilter({ speed: 2, start: 1 })).toBe(
    "atrim=start=1,asetpts=PTS-STARTPTS,atempo=2",
  );
});

test("ffmpegCopyArgs seeks the input and turns the end into a duration", () => {
  expect(ffmpegCopyArgs({})).toEqual({
    input: [],
    output: ["-c", "copy", "-avoid_negative_ts", "make_zero"],
  });
  expect(ffmpegCopyArgs({ start: 10, end: 25.5, stripMetadata: true })).toEqual({
    input: ["-ss", "10"],
    output: ["-t", "15.5", "-c", "copy", "-avoid_negative_ts", "make_zero", "-map_metadata", "-1"],
  });
  expect(ffmpegCopyArgs({ end: 8 }).output.slice(0, 2)).toEqual(["-t", "8"]);
  // what would force a re-encode is left out
  expect(ffmpegCopyArgs({ fps: 10, videoBitrate: 200, maxSize: 640 }).output).toEqual([
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
  ]);
});

test("altersContent separates edits from pure re-encoding", () => {
  expect(altersContent({ quality: 40, videoBitrate: 500 })).toBe(false);
  expect(altersContent({ maxSize: 800 })).toBe(true);
  expect(altersContent({ stripMetadata: true })).toBe(true);
  expect(altersContent({ copyStreams: true })).toBe(false);
  expect(altersContent({ pages: "1" })).toBe(true);
  expect(altersContent({ rotate: "90" })).toBe(true);
  // locking, stamping and audio edits make a file larger, and must not be swapped for the original
  expect(altersContent({ protect: "secret" })).toBe(true);
  expect(altersContent({ pageNumbers: true })).toBe(true);
  expect(altersContent({ fadeIn: 2 })).toBe(true);
  // fewer colours is lossy compression, like quality: a larger result gives way to the original
  expect(altersContent({ colors: 64 })).toBe(false);
});

test("ffmpegAudioFilter builds one chain, with the cut first and loudness last", () => {
  expect(ffmpegAudioFilter({ start: 2 })).toBeUndefined();
  expect(ffmpegAudioFilter({ start: 2, end: 9, fadeIn: 1, normalize: true })).toBe(
    "atrim=start=2:end=9,asetpts=PTS-STARTPTS,afade=t=in:d=1,loudnorm=I=-14:TP=-1",
  );
  // the end is only reachable reversed, and both end-of-file edits share one pair of reversals
  expect(ffmpegAudioFilter({ fadeOut: 3, trimSilence: true, mono: true })).toBe(
    "silenceremove=start_periods=1:start_threshold=-50dB,areverse," +
      "silenceremove=start_periods=1:start_threshold=-50dB,afade=t=in:d=3,areverse," +
      "aformat=channel_layouts=mono",
  );
  expect(ffmpegAudioFilter({ speed: 1.5, reverse: true })).toBe("atempo=1.5,areverse");
  expect(ffmpegTrimArgs({ start: 2, end: 4 })).toEqual(["-ss", "2", "-to", "4"]);
});

const handler = (name: string, ...formats: HandlerDefinition["supportedFormats"] & {}) =>
  ({ name: name as HandlerName, supportedFormats: formats }) satisfies HandlerDefinition;

test("compressorsFor only trusts listed handlers that read and write the format", () => {
  const handlers = [
    // reads and writes JPEG, but as a spectrogram
    handler("meyda", Formats.JPEG.builder("image").fromTo()),
    handler("canvasToBlob", Formats.JPEG.builder("jpeg").fromTo()),
    handler(
      "ImageMagick",
      Formats.JPEG.builder("jpeg").from(),
      Formats.JPEG.builder("jpg").to(),
      Formats.PNG.builder("png").fromTo(),
    ),
    handler("FFmpeg", Formats.MP4.builder("mp4").fromTo(), Formats.MP3.builder("mp3").to()),
    handler("mediabunny", Formats.MP4.builder("mp4").fromTo()),
    handler("pandoc", Formats.DOCX.builder("docx").fromTo()),
    handler("oxipng", Formats.PNG.builder("png").fromTo()),
    // reads and writes PNG, but is not a compressor
    handler("canvasToBlob", Formats.PNG.builder("png").fromTo()),
    handler("compressPdf", Formats.PDF.builder("pdf").fromTo()),
    handler("mupdf", Formats.PDF.builder("pdf").fromTo()),
  ];
  const names = (format: (typeof handlers)[number]["supportedFormats"][number]) =>
    compressorsFor(format, handlers).map(([, h]) => h.name as string);

  expect(names(Formats.JPEG.builder("x").nowhere())).toEqual(["ImageMagick", "canvasToBlob"]);
  expect(names(Formats.MP4.builder("x").nowhere())).toEqual(["mediabunny", "FFmpeg"]);
  expect(names(Formats.PNG.builder("x").nowhere())).toEqual(["oxipng"]);
  // fewer colours is lossy, which oxipng won't do
  const quantising = compressorsFor(Formats.PNG.builder("x").nowhere(), handlers, { colors: 64 });
  expect(quantising.map(([, h]) => h.name as string)).toEqual(["ImageMagick"]);
  // nor will it stamp a watermark
  const stamping = compressorsFor(Formats.PNG.builder("x").nowhere(), handlers, { watermark: "A" });
  expect(stamping.map(([, h]) => h.name as string)).toEqual(["ImageMagick"]);
  expect(names(Formats.PDF.builder("x").nowhere())).toEqual(["compressPdf"]);
  // mediabunny always re-encodes, so a stream copy leaves only FFmpeg
  const copying = compressorsFor(Formats.MP4.builder("x").nowhere(), handlers, {
    copyStreams: true,
  });
  expect(copying.map(([, h]) => h.name as string)).toEqual(["FFmpeg"]);
  // nor does mediabunny have audio filters
  const fading = compressorsFor(Formats.MP4.builder("x").nowhere(), handlers, { fadeIn: 1 });
  expect(fading.map(([, h]) => h.name as string)).toEqual(["FFmpeg"]);
  const faster = compressorsFor(Formats.MP4.builder("x").nowhere(), handlers, { speed: 2 });
  expect(faster.map(([, h]) => h.name as string)).toEqual(["FFmpeg"]);
  // FFmpeg can't read MP3 here, and DOCX isn't on the list at all
  expect(names(Formats.MP3.builder("x").nowhere())).toEqual([]);
  expect(names(Formats.DOCX.builder("x").nowhere())).toEqual([]);
});
