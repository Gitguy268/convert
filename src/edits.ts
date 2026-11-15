import type { FileFormat, HandlerDefinition } from "./FormatHandler.js";
import { sameFormat } from "./FormatHandler.js";
import { Category } from "./Formats.js";
import type { ConvertOptions } from "./Settings.js";

/**
 * The fork's edits on top of upstream's settings (src/Settings.ts): the FFmpeg filters that
 * apply them, the clean-up that makes a set of them consistent, and the "Compress" route.
 */
export type Edits = ConvertOptions;

/** Settings that only FFmpeg's audio filters can apply. */
const AUDIO_EDITS = ["normalize", "fadeIn", "fadeOut", "mono", "reverse", "trimSilence", "speed"];

/** Whether the settings ask for an audio edit, which only FFmpeg can make. */
export function hasAudioEdits(settings: Edits) {
  return AUDIO_EDITS.some((key) => settings[key]);
}

export function categoriesOf(format: FileFormat) {
  return Array.isArray(format.category) ? format.category : [format.category];
}

/**
 * Drops the combinations that cannot work together. Run on the settings before a conversion.
 * @param userSettings What the user set, to tell their quality from {@link COMPRESS_DEFAULTS}.
 */
export function tidyEdits(settings: Edits, userSettings: Edits = settings): Edits {
  const out: Edits = { ...settings };
  for (const key of ["pages", "password", "protect", "watermark"]) {
    if (typeof out[key] === "string") out[key] = (out[key] as string).trim() || undefined;
    if (out[key] === undefined) delete out[key];
  }
  if (out.speed === 1) delete out.speed;
  // filters re-encode the audio, so a stream can't be copied as it is
  if (hasAudioEdits(out)) delete out.copyStreams;
  // editing pages is not a request to re-encode the images at the default quality
  const pdfEdit = out.pages || out.rotate || out.password || out.protect || out.pageNumbers;
  if ((pdfEdit || out.watermark) && !userSettings.quality) delete out.quality;
  // an end before the start would produce an empty file
  if (out.start && out.end && (out.end as number) <= (out.start as number)) delete out.end;
  return out;
}

/** Whether the settings change what the file contains, rather than only how well it is encoded. */
export function altersContent(settings: Edits) {
  return !!(
    settings.maxSize ||
    settings.width ||
    settings.height ||
    settings.start ||
    settings.end ||
    settings.stripMetadata ||
    settings.pages ||
    settings.rotate ||
    settings.password ||
    settings.protect ||
    settings.pageNumbers ||
    settings.watermark ||
    hasAudioEdits(settings)
  );
}

/** Scales the longest side down to `maxSize`, keeping the aspect ratio and even dimensions. */
export function ffmpegScaleFilter(settings: Edits): string | undefined {
  const n = settings.maxSize;
  if (!n) return undefined;
  return `scale=w='min(iw,${n})':h='min(ih,${n})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

/** Output options that cut the result to the chosen section. */
export function ffmpegTrimArgs(settings: Edits): string[] {
  const args: string[] = [];
  if (settings.start) args.push("-ss", String(settings.start));
  if (settings.end) args.push("-to", String(settings.end));
  return args;
}

/**
 * Arguments that cut a file without re-encoding it, the way LosslessCut does: seek in the input
 * and copy the streams. The result starts at the keyframe before `start`, because a copied
 * video stream can only begin on one.
 */
export function ffmpegCopyArgs(settings: Edits): {
  input: string[];
  output: string[];
} {
  const input = settings.start ? ["-ss", String(settings.start)] : [];
  const output: string[] = [];
  // seeking the input restarts its clock at zero, so the end becomes a duration
  if (settings.end) output.push("-t", String(settings.end - (settings.start ?? 0)));
  output.push("-c", "copy", "-avoid_negative_ts", "make_zero");
  if (settings.stripMetadata) output.push("-map_metadata", "-1");
  return { input, output };
}

/**
 * The audio edits as one "-af" filter chain, or undefined if none are set.
 * The cut happens here too, so that the fades land on the part that is kept.
 *
 * shortcut: the end of a file is only reachable by reversing it, and `areverse` holds all the
 * decoded audio in memory (about 500 MB per hour of stereo). Fine for songs; probe the duration
 * and use `afade=t=out:st=` instead if long recordings run out of memory.
 */
export function ffmpegAudioFilter(settings: Edits): string | undefined {
  if (!hasAudioEdits(settings)) return undefined;
  const { start, end, speed, fadeIn, fadeOut } = settings;
  const filters: string[] = [];
  if (start || end) {
    filters.push(
      `atrim=${[start && `start=${start}`, end && `end=${end}`].filter(Boolean).join(":")}`,
    );
    filters.push("asetpts=PTS-STARTPTS");
  }
  if (speed) filters.push(`atempo=${speed}`);
  if (settings.reverse) filters.push("areverse");
  // removes everything quieter than -50 dB before the first sound
  const silence = "silenceremove=start_periods=1:start_threshold=-50dB";
  if (settings.trimSilence) filters.push(silence);
  if (fadeIn) filters.push(`afade=t=in:d=${fadeIn}`);
  if (settings.trimSilence || fadeOut) {
    filters.push("areverse");
    if (settings.trimSilence) filters.push(silence);
    if (fadeOut) filters.push(`afade=t=in:d=${fadeOut}`);
    filters.push("areverse");
  }
  if (settings.mono) filters.push("aformat=channel_layouts=mono");
  if (settings.normalize) filters.push("loudnorm=I=-14:TP=-1");
  return filters.join(",");
}

/**
 * The video half of a speed change: the same cut as {@link ffmpegAudioFilter} makes, then the
 * frames played faster or slower. Undefined without a speed.
 */
export function ffmpegSpeedFilter(settings: Edits): string | undefined {
  const { start, end, speed } = settings;
  if (!speed) return undefined;
  const cut = [start && `start=${start}`, end && `end=${end}`].filter(Boolean).join(":");
  return `${cut ? `trim=${cut},` : ""}setpts=(PTS-STARTPTS)/${speed}`;
}

/** Defaults for converting a format into itself, where the handler's own default would gain nothing. */
export const COMPRESS_DEFAULTS: Edits = { quality: 70 };

/**
 * Handlers trusted to turn a format into a smaller file of the same format, best first.
 * An explicit list, because "any handler that reads and writes the format" includes handlers
 * that do something else entirely (meyda turns a JPEG spectrogram back into audio data).
 */
const COMPRESSORS: Record<string, string[]> = {
  "image/jpeg": ["ImageMagick", "canvasToBlob"],
  "image/webp": ["ImageMagick", "canvasToBlob"],
  "image/avif": ["ImageMagick"],
  // with a palette size it is lossy, which only ImageMagick does (see `compressorsFor`)
  "image/png": ["oxipng"],
  "application/pdf": ["compressPdf"],
  "image/svg+xml": ["minifySvg"],
  "text/html": ["minifyHtml"],
  "text/css": ["minifyCss"],
  "text/javascript": ["minifyJs"],
  "application/json": ["minifyJson"],
};
const MEDIA_COMPRESSORS = ["mediabunny", "FFmpeg"];

/**
 * Finds the handlers that can compress the given format into itself.
 * @param settings Narrows the choice when a setting needs one particular handler.
 * @returns Output format and handler pairs to try in order. Empty if the format isn't compressible.
 */
export function compressorsFor(
  format: FileFormat,
  handlers: HandlerDefinition[],
  settings: Edits = {},
): [FileFormat, HandlerDefinition][] {
  const categories = categoriesOf(format);
  const isMedia =
    !categories.includes(Category.IMAGE) &&
    (categories.includes(Category.VIDEO) || categories.includes(Category.AUDIO));
  // mediabunny always re-encodes, so only FFmpeg can copy streams, and it has no audio filters
  const media = settings.copyStreams || hasAudioEdits(settings) ? ["FFmpeg"] : MEDIA_COMPRESSORS;
  // oxipng only rewrites the PNG, it can't change what is in it
  const names =
    format.mime === "image/png" && (settings.colors || settings.watermark)
      ? ["ImageMagick"]
      : (COMPRESSORS[format.mime] ?? (isMedia ? media : []));

  const found: [FileFormat, HandlerDefinition][] = [];
  for (const name of names) {
    const handler = handlers.find((h) => h.name === name);
    const formats = handler?.supportedFormats?.filter((f) => sameFormat(f, format)) ?? [];
    const output = formats.find((f) => f.to);
    if (handler && output && formats.some((f) => f.from)) found.push([output, handler]);
  }
  return found;
}
