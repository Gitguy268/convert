import type { ConvertPathNode, FileFormat } from "./FormatHandler.js";

export const SettingCategories = {
  size: { label: "Size", note: "Streches the image when both are set." },
  quality: { label: "Quality", note: "1 is the smallest file, 100 the best quality." },
  trim: { label: "Cut", note: "Times are in seconds from the start of the file." },
  video: { label: "Video" },
  audio: { label: "Audio" },
  pdf: { label: "PDF", note: "Pages are numbers and ranges, such as 2-5,8." },
  look: { label: "Look" },
  secret: {
    label: "Encryption",
    note: "Nothing is sent anywhere. Without the passphrase the file can't be opened again.",
  },
  other: { label: "Other" },
} satisfies Record<string, { label: string; note?: string }>;

export interface OptionDisplay {
  label?: string;
  unit?: string;
  category?: keyof typeof SettingCategories;
  /** A field other than the plain one for its type (src/ui/components/Conversion/SettingsPanel). */
  widget?: "password" | "signature";
}

export type OptionSpec = OptionDisplay &
  (
    | { type: "number"; min?: number; max?: number; integer?: boolean }
    | { type: "enum"; values: string[] }
    | { type: "boolean" }
    | {
        type: "string";
        maxLength?: number;
        pattern?: string;
      }
  );

// oxfmt-ignore
export const Settings = {
  // size
  width: { content: true, category: "size", label: "Width", unit: "px", type: "number", min: 1, integer: true },
  height: { content: true, category: "size", label: "Height", unit: "px", type: "number", min: 1, integer: true },
  // quality
  quality: { category: "quality", label: "Quality", type: "number", min: 1, max: 100, integer: true },
  // video
  videoCodec: { category: "video", label: "Codec", type: "enum", values: [] },
  fps: { content: true, category: "video", label: "Frame rate", unit: "fps", type: "number", min: 1, max: 240 },
  videoBitrate: { category: "video", label: "Bitrate", unit: "kbps", type: "number", min: 1, integer: true },
  // audio
  audioCodec: { category: "audio", label: "Codec", type: "enum", values: [] },
  audioBitrate: { category: "audio", label: "Bitrate", unit: "kbps", type: "number", min: 1, integer: true },
  sampleRate: { content: true, category: "audio", label: "Sample rate", unit: "Hz", type: "number", min: 1000, max: 384000, integer: true },
  channels: { content: true, category: "audio", label: "Channels", type: "number", min: 1, max: 8, integer: true },
  // fork additions (src/edits.ts has the FFmpeg side of them)
  // size: the longest side, never enlarged
  maxSize: { category: "size", label: "Longest side", unit: "px", type: "number", min: 1, integer: true },
  // quality: palette size of a PNG
  colors: { category: "quality", label: "Colours", type: "number", min: 2, max: 256, integer: true },
  // cut
  start: { category: "trim", label: "Start", unit: "s", type: "number", min: 0 },
  end: { category: "trim", label: "End", unit: "s", type: "number", min: 0 },
  copyStreams: { category: "trim", label: "Cut without re-encoding", type: "boolean" },
  speed: { category: "trim", label: "Speed", unit: "×", type: "number", min: 0.5, max: 4 },
  // audio edits
  normalize: { category: "audio", label: "Even out loudness", type: "boolean" },
  fadeIn: { category: "audio", label: "Fade in", unit: "s", type: "number", min: 0 },
  fadeOut: { category: "audio", label: "Fade out", unit: "s", type: "number", min: 0 },
  mono: { category: "audio", label: "Mono", type: "boolean" },
  reverse: { category: "audio", label: "Reverse", type: "boolean" },
  trimSilence: { category: "audio", label: "Cut silence at the ends", type: "boolean" },
  // pdf (mupdf takes passwords in a "key=value,key=value" string, so no commas or equals signs)
  pages: { category: "pdf", label: "Pages", type: "string", maxLength: 200, pattern: "\\s*\\d+(\\s*-\\s*\\d+)?(\\s*,\\s*\\d+(\\s*-\\s*\\d+)?)*\\s*" },
  rotate: { category: "pdf", label: "Rotate", unit: "°", type: "enum", values: ["90", "180", "270"] },
  password: { category: "pdf", label: "Password to open it", type: "string", maxLength: 100, pattern: "[^,=]+" },
  protect: { category: "pdf", label: "Protect with password", type: "string", maxLength: 100, pattern: "[^,=]+" },
  pageNumbers: { category: "pdf", label: "Number the pages", type: "boolean" },
  redact: { category: "pdf", label: "Redact text", type: "string", maxLength: 500 },
  signature: { category: "pdf", label: "Signature", type: "string", maxLength: 400_000, widget: "signature" },
  signaturePage: { category: "pdf", label: "Signature on page", type: "number", min: 1, integer: true },
  signatureCorner: { category: "pdf", label: "Signature corner", type: "enum", values: ["bottom right", "bottom left", "top right", "top left"] },
  // look: frames, slides, boards and themes
  frameStyle: { category: "look", label: "Frame", type: "enum", values: ["card", "Win98 window", "liquid glass window", "macOS window"] },
  frameTitle: { category: "look", label: "Window title", type: "string", maxLength: 80 },
  background: { category: "look", label: "Background", type: "enum", values: ["sky", "sunset", "mint", "graphite", "white", "transparent"] },
  look: { category: "look", label: "Look", type: "enum", values: ["plain", "Win98", "liquid glass", "Xiao"] },
  // fonts
  subsetText: { category: "other", label: "Characters to keep", type: "string", maxLength: 5000 },
  // encryption
  passphrase: { category: "secret", label: "Passphrase", type: "string", maxLength: 200, widget: "password" },
  // other
  stripMetadata: { category: "other", label: "Remove metadata", type: "boolean" },
  watermark: { category: "other", label: "Watermark", type: "string", maxLength: 100 },
} satisfies Record<string, OptionSpec & { content?: true }>; // content settings are applied at each step

export type ConvertOptions = {
  [K in keyof typeof Settings]?: (typeof Settings)[K] extends { type: "number" }
    ? number
    : (typeof Settings)[K] extends { type: "boolean" }
      ? boolean
      : string;
} & { [key: string]: unknown };

export type FormatOptions = Record<string, OptionSpec | true>;

const own = <T>(object: Record<string, T> | undefined, key: string) =>
  object && Object.hasOwn(object, key) ? object[key] : undefined;

function specOf(format: FileFormat, key: string): OptionSpec | undefined {
  const declared = own(format.options, key);
  return declared === true ? own<OptionSpec>(Settings, key) : declared;
}

export function isValidOption(spec: OptionSpec, value: unknown): boolean {
  if (spec.type === "enum") return typeof value === "string" && spec.values.includes(value);
  if (spec.type === "boolean") return typeof value === "boolean";
  if (spec.type === "string") {
    if (typeof value !== "string" || value.length > (spec.maxLength ?? Infinity)) return false;
    if (spec.pattern === undefined) return true;
    try {
      return new RegExp(`^(?:${spec.pattern})$`, "u").test(value);
    } catch {
      return false;
    }
  }
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!spec.integer || Number.isInteger(value)) &&
    value >= (spec.min ?? -Infinity) &&
    value <= (spec.max ?? Infinity)
  );
}

export function sanitizeOptions(format: FileFormat, options: ConvertOptions = {}): ConvertOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([key, value]) => {
      const spec = specOf(format, key);
      return spec && isValidOption(spec, value);
    }),
  );
}

function stepSupports(node: ConvertPathNode, key: string, value: unknown) {
  const spec = specOf(node.format, key);
  return spec !== undefined && isValidOption(spec, value);
}

export const pathSupportsOptions = (path: ConvertPathNode[], settings: ConvertOptions) =>
  Object.entries(settings).every(
    ([key, value]) => path.length > 1 && stepSupports(path[path.length - 1], key, value),
  );

export function distributeOptions(path: ConvertPathNode[], settings: ConvertOptions) {
  const result: ConvertPathNode[] = path.map((node) => ({ ...node, options: undefined }));
  const unsupported: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const content = own<OptionSpec & { content?: true }>(Settings, key)?.content;
    const steps = result
      .slice(content ? 1 : Math.max(1, result.length - 1))
      .filter((node) => stepSupports(node, key, value));
    for (const node of steps) (node.options ??= {})[key] = value;
    if (!steps.length) unsupported.push(key);
  }
  return { path: result, unsupported };
}
