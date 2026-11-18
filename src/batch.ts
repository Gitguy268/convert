import type { FileData, FileFormat, HandlerDefinition } from "./FormatHandler.js";
import { formatIdentifier, sameFormat } from "./FormatHandler.js";
import { getExt, stripExt } from "./common/index.js";
import { AUDIO_FILES, Category } from "./Formats.js";
import { detectFormatMatches } from "./detectFormat.js";

const categoriesOf = (format: FileFormat) =>
  Array.isArray(format.category) ? format.category : [format.category];

type Option = [FileFormat, HandlerDefinition];
type OptionsMap = Map<FileFormat, HandlerDefinition>;

/** What one selected file is converted from and to. */
export interface Target {
  from: Option | null;
  to: Option | null;
}

export interface TargetGroup<T> {
  from: Option;
  to: Option;
  items: T[];
}

function optionKey([format, handler]: Option) {
  return `${handler.name}|${format.mime}(${format.format})`;
}

/**
 * Groups items that share an input and an output option, keeping first-seen order.
 * Items of one group are converted together, so handlers that merge their inputs still can.
 */
export function groupByTarget<T extends { from: Option; to: Option }>(
  items: T[],
): TargetGroup<T>[] {
  const groups = new Map<string, TargetGroup<T>>();
  for (const item of items) {
    const key = `${optionKey(item.from)}>${optionKey(item.to)}`;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { from: item.from, to: item.to, items: [item] });
  }
  return [...groups.values()];
}

/** Renames repeated names to "name (2).ext", "name (3).ext" and so on. */
export function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let unique = name;
    for (let n = 2; taken.has(unique); n++) {
      const base = stripExt(name);
      unique = `${base} (${n})${name.slice(base.length)}`;
    }
    taken.add(unique);
    return unique;
  });
}

/**
 * Swaps each output for its input wherever the output isn't smaller.
 * Outputs are returned untouched if they don't map one-to-one onto the inputs.
 */
export function keepSmaller(inputs: FileData[], outputs: FileData[]): FileData[] {
  if (inputs.length !== outputs.length) return outputs;
  return outputs.map((output, i) =>
    output.bytes.length < inputs[i].bytes.length ? output : inputs[i],
  );
}

/** Input formats a file could be, best match first (upstream's shared detection, src/detectFormat.ts). */
export function getMatchingFromFormats(options: OptionsMap, files: File[]): OptionsMap {
  if (files.length === 0) return new Map();
  const fromFormats = [...options.keys()].filter((format) => format.from);
  return new Map(
    detectFormatMatches(files[0], fromFormats, { loose: true }).map(({ format }) => [
      format,
      options.get(format)!,
    ]),
  );
}

function fileExt(file: File) {
  return getExt(file.name).toLowerCase();
}

/** Picks the input format when the file leaves no real doubt about it. */
function autoFromOption(options: OptionsMap, file: File, simple: boolean): Option | null {
  const fromFormats = [...options.keys()].filter((format) => format.from);
  const matches = detectFormatMatches(file, fromFormats, { loose: true });
  if (!matches.length) return null;
  const first: Option = [matches[0].format, options.get(matches[0].format)!];
  if (!simple) return matches.length === 1 ? first : null;
  // chances are, an exact extension + MIME match is what the user wants
  if (matches[0].match === "exact") return first;
  const uniqueFormats = new Set(matches.map(({ format }) => formatIdentifier(format)));
  return uniqueFormats.size === 1 ? first : null;
}

/**
 * The last choice for each file extension, so that the next file of that kind starts from it.
 * Lives as long as the page, like upstream's remembered selection.
 */
const remembered = new Map<string, { from: Option; to: Option }>();

/** Remembers the choice made for files with this extension. */
export function rememberTarget(file: File, target: Target) {
  if (target.from && target.to) remembered.set(fileExt(file), { from: target.from, to: target.to });
}

/** Fills in a target for every selected file that `stored` doesn't cover yet. */
export function resolveTargets(
  options: OptionsMap,
  files: [string, File][],
  stored: Record<string, Target>,
  simple: boolean,
): Record<string, Target> {
  const targets: Record<string, Target> = {};
  for (const [key, file] of files) {
    if (stored[key]) {
      targets[key] = stored[key];
      continue;
    }
    const last = remembered.get(fileExt(file));
    if (last && options.has(last.from[0]) && options.has(last.to[0])) {
      targets[key] = { ...last };
      continue;
    }
    const from = autoFromOption(options, file, simple);
    // a new file takes the output already chosen for files of its format
    const sibling =
      from && Object.values(targets).find((t) => t.from && t.to && sameFormat(t.from[0], from[0]));
    targets[key] = { from, to: sibling ? sibling.to : null };
  }
  return targets;
}

/** Keys of the other files that a choice for the file under `activeKey` also applies to. */
export function siblingKeys(
  files: [string, File][],
  targets: Record<string, Target>,
  activeKey: string | undefined,
  kind: keyof Target,
): string[] {
  const activeFile = files.find(([key]) => key === activeKey)?.[1];
  if (!activeKey || !activeFile) return [];
  const activeFrom = targets[activeKey]?.from;
  return files
    .filter(([key, file]) => {
      if (key === activeKey) return false;
      // the input format is a guess from the name, the output follows the input format
      if (kind === "from") return fileExt(file) === fileExt(activeFile);
      const from = targets[key].from;
      return !!from && !!activeFrom && sameFormat(from[0], activeFrom[0]);
    })
    .map(([key]) => key);
}

/**
 * The special outputs that fit an input and deserve a shortcut, as the `format` of their
 * output: a long list of formats does not tell anyone that a PNG can be read or cut out.
 * @param sameTypeCount How many of the selected files have this input format.
 * @param hasWebGpu Whether the browser can run the upscalers at all.
 */
export function toolsFor(from: FileFormat, sameTypeCount: number, hasWebGpu: boolean): string[] {
  return [...mediaToolsFor(from, sameTypeCount, hasWebGpu), ...fileToolsFor(from)];
}

/** Tools that read any file, after the ones for its kind. */
function fileToolsFor(from: FileFormat): string[] {
  if (from.format === "age") return ["age-opened"];
  return ["age"];
}

function mediaToolsFor(from: FileFormat, sameTypeCount: number, hasWebGpu: boolean): string[] {
  if (from.mime === "application/pdf") {
    return [
      "ocr",
      "pdf-pages",
      "pdf-redacted",
      "pdf-signed",
      ...(sameTypeCount > 1 ? ["pdf-merged"] : []),
    ];
  }
  if (from.mime === "application/json") return ["ts"];
  if (from.mime === "text/markdown") return ["slides", "slides-pdf", "kanban"];
  if (from.mime === "text/plain" && from.format === "text") return ["slides", "slides-pdf"];
  if (from.format === "mhtml") return ["archived-page"];
  if (from.mime === "application/zip" && from.format === "zip") return ["archived-page"];
  if (from.format === "gpl") return ["looks"];
  if (categoriesOf(from).includes(Category.FONT) && from.mime.startsWith("font/")) {
    return ["woff2-subset", "ttf-subset", "font-specimen"];
  }
  const categories = categoriesOf(from);
  // a GIF is both: it goes with video, where a single still is not what is asked for
  if (categories.includes(Category.VIDEO)) {
    if (categories.includes(Category.IMAGE)) {
      return hasWebGpu ? ["upscaled-film", "upscaled-animation"] : [];
    }
    return [
      "contact-sheet",
      ...(hasWebGpu ? ["upscaled-film", "upscaled-animation"] : []),
      "metadata",
    ];
  }
  if (categories.includes(Category.IMAGE) && !categories.includes(Category.VECTOR)) {
    const clean = CLEAN_FORMATS[from.mime];
    // the metadata report and coloured ASCII art are in the format list: the row is long enough
    return [
      "ocr",
      "nobg",
      ...(hasWebGpu ? ["upscaled-photo", "upscaled-drawing"] : []),
      "favicon",
      "framed",
      "halftone",
      "depth",
      ...(clean ? [clean] : []),
      ...(clean ? ["looks"] : []),
      ...(sameTypeCount > 1 ? ["collage", "pdf-from-images"] : []),
    ];
  }
  if (categories.includes(Category.AUDIO)) {
    // judged on the file itself, so only for the formats the check reads as they are
    const direct = AUDIO_FILES.some((f) => sameFormat(f, from));
    return [...(direct ? ["audio-check"] : []), "audio-video", "metadata"];
  }
  return [];
}

/** The "Remove metadata" tool of each picture format it reads without decoding. */
const CLEAN_FORMATS: Record<string, string> = {
  "image/jpeg": "clean-jpeg",
  "image/png": "clean-png",
  "image/webp": "clean-webp",
};
