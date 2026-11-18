import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { changeExt } from "src/common/index.ts";

/**
 * Removes what a picture says about itself (camera, time, place, editing software, comments)
 * without decoding it, so not a pixel changes: JPEG segments, PNG chunks and WebP chunks are
 * left out. The orientation and the colour profile stay, because they change how it looks.
 */

const clean = (name: string, format: string, extension: string, mime: string) =>
  new FormatDefinition(name, format, extension, mime, Category.IMAGE);

export const CLEAN_JPEG = clean("JPEG without metadata", "clean-jpeg", "jpg", "image/jpeg");
export const CLEAN_PNG = clean("PNG without metadata", "clean-png", "png", "image/png");
export const CLEAN_WEBP = clean("WebP without metadata", "clean-webp", "webp", "image/webp");

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

// ---------------------------------------------------------------------------- EXIF reading

export interface ExifSummary {
  orientation?: number;
  make?: string;
  model?: string;
  taken?: string;
  software?: string;
  gps?: { latitude: number; longitude: number };
}

/** Degrees, minutes and seconds as degrees. */
const degrees = (v: number[]) => (v[0] ?? 0) + (v[1] ?? 0) / 60 + (v[2] ?? 0) / 3600;

/** Reads the few EXIF fields this tool reports, from a TIFF structure (the body of APP1). */
export function readExif(tiff: Uint8Array): ExifSummary {
  const out: ExifSummary = {};
  if (tiff.length < 8) return out;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = ascii(tiff, 0, 2) === "II";
  if (!little && ascii(tiff, 0, 2) !== "MM") return out;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  const inside = (o: number, n: number) => o >= 0 && o + n <= tiff.length;

  type Entry = { tag: number; type: number; count: number; at: number };
  const entries = (offset: number): Entry[] => {
    if (!inside(offset, 2)) return [];
    const n = u16(offset);
    const list: Entry[] = [];
    for (let i = 0; i < n; i++) {
      const at = offset + 2 + i * 12;
      if (!inside(at, 12)) break;
      list.push({ tag: u16(at), type: u16(at + 2), count: u32(at + 4), at });
    }
    return list;
  };
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const valueOffset = (e: Entry) => {
    const size = (sizes[e.type] ?? 1) * e.count;
    return size <= 4 ? e.at + 8 : u32(e.at + 8);
  };
  const text = (e: Entry) => {
    const o = valueOffset(e);
    if (!inside(o, e.count)) return undefined;
    return ascii(tiff, o, e.count).replace(/\0+$/, "").trim() || undefined;
  };
  const rationals = (e: Entry) => {
    const o = valueOffset(e);
    const values: number[] = [];
    for (let i = 0; i < e.count && inside(o + i * 8, 8); i++) {
      const d = u32(o + i * 8 + 4);
      values.push(d ? u32(o + i * 8) / d : 0);
    }
    return values;
  };

  const ifd0 = entries(u32(4));
  let exifIfd: number | undefined;
  let gpsIfd: number | undefined;
  for (const e of ifd0) {
    if (e.tag === 0x0112) out.orientation = u16(e.at + 8);
    else if (e.tag === 0x010f) out.make = text(e);
    else if (e.tag === 0x0110) out.model = text(e);
    else if (e.tag === 0x0131) out.software = text(e);
    else if (e.tag === 0x0132) out.taken ??= text(e);
    else if (e.tag === 0x8769) exifIfd = u32(e.at + 8);
    else if (e.tag === 0x8825) gpsIfd = u32(e.at + 8);
  }
  if (exifIfd !== undefined) {
    for (const e of entries(exifIfd)) if (e.tag === 0x9003) out.taken = text(e) ?? out.taken;
  }
  if (gpsIfd !== undefined) {
    let lat: number[] | undefined;
    let lon: number[] | undefined;
    let latRef = "N";
    let lonRef = "E";
    for (const e of entries(gpsIfd)) {
      if (e.tag === 1) latRef = text(e) ?? latRef;
      else if (e.tag === 2) lat = rationals(e);
      else if (e.tag === 3) lonRef = text(e) ?? lonRef;
      else if (e.tag === 4) lon = rationals(e);
    }
    if (lat?.length && lon?.length && (degrees(lat) || degrees(lon))) {
      out.gps = {
        latitude: degrees(lat) * (latRef.startsWith("S") ? -1 : 1),
        longitude: degrees(lon) * (lonRef.startsWith("W") ? -1 : 1),
      };
    }
  }
  return out;
}

/** The smallest EXIF block that keeps a picture upright: one IFD with one Orientation entry. */
export function orientationExif(orientation: number): Uint8Array {
  const bytes = new Uint8Array(6 + 26);
  bytes.set([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
  const view = new DataView(bytes.buffer, 6);
  bytes.set([0x4d, 0x4d], 6); // big-endian
  view.setUint16(2, 42);
  view.setUint32(4, 8); // IFD0 right after the header
  view.setUint16(8, 1); // one entry
  view.setUint16(10, 0x0112);
  view.setUint16(12, 3); // SHORT
  view.setUint32(14, 1);
  view.setUint16(18, orientation);
  view.setUint32(22, 0); // no next IFD
  return bytes;
}

// ---------------------------------------------------------------------------- JPEG

export interface MetadataFound {
  /** Kinds of metadata, as people know them: "EXIF", "GPS location", "XMP", ... */
  kinds: string[];
  exif?: ExifSummary;
}

type Segment = { marker: number; start: number; end: number };

function jpegSegments(bytes: Uint8Array): { segments: Segment[]; scan: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("This is not a JPEG.");
  const segments: Segment[] = [];
  let o = 2;
  while (o + 4 <= bytes.length) {
    if (bytes[o] !== 0xff) throw new Error("The JPEG is damaged: no marker where one should be.");
    const marker = bytes[o + 1];
    if (marker === 0xff) {
      o++; // fill byte
      continue;
    }
    // start of scan: the picture itself, copied as it is to the end
    if (marker === 0xda) return { segments, scan: o };
    const length = (bytes[o + 2] << 8) | bytes[o + 3];
    segments.push({ marker, start: o, end: o + 2 + length });
    o += 2 + length;
  }
  throw new Error("The JPEG ends before its picture starts.");
}

const isExif = (b: Uint8Array, s: Segment) =>
  s.marker === 0xe1 && ascii(b, s.start + 4, 6) === "Exif\0\0";
const isXmp = (b: Uint8Array, s: Segment) =>
  s.marker === 0xe1 && ascii(b, s.start + 4, 28).startsWith("http://ns.adobe.com/xap/");
const isIcc = (b: Uint8Array, s: Segment) =>
  s.marker === 0xe2 && ascii(b, s.start + 4, 12) === "ICC_PROFILE\0";

function describeJpeg(bytes: Uint8Array): MetadataFound {
  const { segments } = jpegSegments(bytes);
  const kinds = new Set<string>();
  let exif: ExifSummary | undefined;
  for (const s of segments) {
    if (isExif(bytes, s)) {
      kinds.add("EXIF");
      exif = readExif(bytes.subarray(s.start + 10, s.end));
    } else if (isXmp(bytes, s)) kinds.add("XMP");
    else if (s.marker === 0xed) kinds.add("IPTC (Photoshop)");
    else if (s.marker === 0xfe) kinds.add("comments");
    else if (s.marker >= 0xe1 && s.marker <= 0xef && s.marker !== 0xee && !isIcc(bytes, s)) {
      kinds.add(`APP${s.marker - 0xe0} block`);
    }
  }
  if (exif?.gps) kinds.add("GPS location");
  return { kinds: [...kinds], exif };
}

/** Leaves out every APP segment but JFIF, the colour profile and Adobe's, and every comment. */
export function stripJpeg(bytes: Uint8Array): Uint8Array {
  const { segments, scan } = jpegSegments(bytes);
  const orientation = describeJpeg(bytes).exif?.orientation;
  const kept = segments.filter(
    (s) =>
      s.marker === 0xe0 || // JFIF
      s.marker === 0xee || // Adobe: says how CMYK is stored
      isIcc(bytes, s) ||
      (!(s.marker >= 0xe1 && s.marker <= 0xef) && s.marker !== 0xfe),
  );
  const parts = kept.map((s) => bytes.subarray(s.start, s.end));
  // a turned photo stays turned: its orientation goes back in on its own, after JFIF
  if (orientation && orientation !== 1) {
    const body = orientationExif(orientation);
    const length = body.length + 2;
    const at = kept[0]?.marker === 0xe0 ? 1 : 0;
    parts.splice(at, 0, new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff]), body);
  }
  return concat([bytes.subarray(0, 2), ...parts, bytes.subarray(scan)]);
}

// ---------------------------------------------------------------------------- PNG

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Chunks that say something about the picture's origin and nothing about how it looks. */
const PNG_METADATA: Record<string, string> = {
  tEXt: "text",
  iTXt: "text",
  zTXt: "text",
  eXIf: "EXIF",
  tIME: "time it was changed",
};

function pngChunks(bytes: Uint8Array) {
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error("This is not a PNG.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; start: number; end: number }[] = [];
  let o = 8;
  while (o + 12 <= bytes.length) {
    const length = view.getUint32(o);
    const type = ascii(bytes, o + 4, 4);
    chunks.push({ type, start: o, end: o + 12 + length });
    o += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function describePng(bytes: Uint8Array): MetadataFound {
  const kinds = new Set<string>();
  let exif: ExifSummary | undefined;
  for (const chunk of pngChunks(bytes)) {
    const kind = PNG_METADATA[chunk.type];
    if (!kind) continue;
    if (chunk.type === "eXIf") exif = readExif(bytes.subarray(chunk.start + 8, chunk.end - 4));
    if (chunk.type === "iTXt" && ascii(bytes, chunk.start + 8, 17) === "XML:com.adobe.xmp") {
      kinds.add("XMP");
    } else kinds.add(kind);
  }
  if (exif?.gps) kinds.add("GPS location");
  return { kinds: [...kinds], exif };
}

export function stripPng(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  for (const chunk of pngChunks(bytes)) {
    if (!PNG_METADATA[chunk.type]) parts.push(bytes.subarray(chunk.start, chunk.end));
  }
  return concat(parts);
}

// ---------------------------------------------------------------------------- WebP

function webpChunks(bytes: Uint8Array) {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    throw new Error("This is not a WebP.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; start: number; end: number }[] = [];
  let o = 12;
  while (o + 8 <= bytes.length) {
    const size = view.getUint32(o + 4, true);
    const end = Math.min(bytes.length, o + 8 + size + (size & 1));
    chunks.push({ type: ascii(bytes, o, 4), start: o, end });
    o = end;
  }
  return chunks;
}

function describeWebp(bytes: Uint8Array): MetadataFound {
  const kinds = new Set<string>();
  let exif: ExifSummary | undefined;
  for (const chunk of webpChunks(bytes)) {
    if (chunk.type === "EXIF") {
      kinds.add("EXIF");
      let body = bytes.subarray(chunk.start + 8, chunk.end);
      if (ascii(body, 0, 6) === "Exif\0\0") body = body.subarray(6);
      exif = readExif(body);
    } else if (chunk.type === "XMP ") kinds.add("XMP");
  }
  if (exif?.gps) kinds.add("GPS location");
  return { kinds: [...kinds], exif };
}

export function stripWebp(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const chunk of webpChunks(bytes)) {
    if (chunk.type === "EXIF" || chunk.type === "XMP ") continue;
    let part = bytes.slice(chunk.start, chunk.end);
    // the extended header says which chunks follow: clear the EXIF and XMP flags
    if (chunk.type === "VP8X") part[8] &= ~0x0c;
    parts.push(part);
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12));
  out.set(body, 12);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

// ---------------------------------------------------------------------------- shared

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/** Which kind of picture this is, by its first bytes. */
function sniff(bytes: Uint8Array): "jpeg" | "png" | "webp" | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  return undefined;
}

/** What a picture says about itself. Never throws: a file it can't read has nothing found. */
export function findMetadata(bytes: Uint8Array): MetadataFound {
  try {
    const kind = sniff(bytes);
    if (kind === "jpeg") return describeJpeg(bytes);
    if (kind === "png") return describePng(bytes);
    if (kind === "webp") return describeWebp(bytes);
  } catch {
    // nothing found
  }
  return { kinds: [] };
}

/** One line for the result popup about what was in a picture. */
export function describeFound(name: string, found: MetadataFound): string {
  if (!found.kinds.length) return `${name}: had no metadata.`;
  const details: string[] = [];
  const { exif } = found;
  if (exif?.gps) {
    const { latitude: lat, longitude: lon } = exif.gps;
    details.push(
      `GPS location ${Math.abs(lat).toFixed(5)}°${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(5)}°${lon < 0 ? "W" : "E"}`,
    );
  }
  const camera = [exif?.make, exif?.model].filter(Boolean).join(" ");
  if (camera) details.push(`camera ${camera}`);
  if (exif?.taken) details.push(`taken ${exif.taken}`);
  if (exif?.software) details.push(`made with ${exif.software}`);
  const other = found.kinds.filter((k) => k !== "GPS location");
  return `${name}: removed ${other.join(", ")}${details.length ? ` (${details.join("; ")})` : ""}.`;
}

class stripMetadataHandler implements FormatHandler {
  public readonly name = "stripMetadata";
  public supportedFormats = [
    Formats.JPEG.builder("jpeg").from(),
    Formats.PNG.builder("png").from(),
    Formats.WEBP.builder("webp").from(),
    CLEAN_JPEG.builder("jpeg").lossless().to(),
    CLEAN_PNG.builder("png").lossless().to(),
    CLEAN_WEBP.builder("webp").lossless().to(),
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
    return inputFiles.map((file, i) => {
      ctx?.progress(`Removing metadata from ${file.name}...`, i / inputFiles.length);
      const kind = sniff(file.bytes);
      if (kind !== outputFormat.internal) {
        throw new Error(`${file.name} is not a ${outputFormat.internal.toUpperCase()} inside.`);
      }
      const strip = kind === "jpeg" ? stripJpeg : kind === "png" ? stripPng : stripWebp;
      return {
        name: changeExt(file.name, outputFormat.extension, "-clean"),
        bytes: strip(file.bytes),
      };
    });
  }
}

export default stripMetadataHandler;
