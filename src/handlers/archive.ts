import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { changeExt, decode, encode } from "src/common/index.ts";
import { DOMParser } from "linkedom/worker";
import mime from "mime";

export const MHTML = new FormatDefinition(
  "MHTML web archive",
  "mhtml",
  "mhtml",
  // what browsers and the mime package call both .mht and .mhtml
  "message/rfc822",
  [Category.DOCUMENT, Category.ARCHIVE],
);
export const ARCHIVED_PAGE = new FormatDefinition(
  "Web page in one file (HTML)",
  "archived-page",
  "html",
  "text/html",
  [Category.DOCUMENT],
);

/** The page may show what it holds and nothing else: no script, no requests. */
const ARCHIVE_CSP =
  "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; frame-src data:";

/** Resources of a saved page, by every name the page may use for them. */
type Resources = Map<string, { type: string; bytes: Uint8Array }>;

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

// ---------------------------------------------------------------------------- MHTML

function decodeQuotedPrintable(text: string): Uint8Array {
  const bytes: number[] = [];
  const soft = text.replace(/=\r?\n/g, "");
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i];
    if (c === "=" && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(bytes);
}

const header = (head: string, name: string) =>
  new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, "im")
    .exec(head)?.[1]
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();

/** The parts of an MHTML file: the first HTML part is the page, the rest its resources. */
export function parseMhtml(bytes: Uint8Array): {
  page: string;
  base: string;
  resources: Resources;
} {
  // latin1 keeps every byte as one character, so binary parts survive the string handling
  const text = new TextDecoder("latin1").decode(bytes);
  const split = /\r?\n\r?\n/.exec(text);
  if (!split) throw new Error("This MHTML file has no header.");
  const head = text.slice(0, split.index);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(header(head, "Content-Type") ?? "")?.[1];
  if (!boundary) throw new Error("This MHTML file has no parts.");
  const resources: Resources = new Map();
  let page: string | undefined;
  let base = "";
  for (const chunk of text.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith("--")) break;
    const gap = /\r?\n\r?\n/.exec(chunk);
    if (!gap) continue;
    const partHead = chunk.slice(0, gap.index);
    const body = chunk.slice(gap.index + gap[0].length).replace(/\r?\n$/, "");
    const type = (header(partHead, "Content-Type") ?? "application/octet-stream")
      .split(";")[0]
      .trim();
    const encoding = (header(partHead, "Content-Transfer-Encoding") ?? "binary").toLowerCase();
    const location = header(partHead, "Content-Location");
    const id = header(partHead, "Content-ID")?.replace(/^<|>$/g, "");
    const raw =
      encoding === "base64"
        ? Uint8Array.from(atob(body.replace(/\s+/g, "")), (c) => c.charCodeAt(0))
        : encoding === "quoted-printable"
          ? decodeQuotedPrintable(body)
          : Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
    if (page === undefined && type === "text/html") {
      const charset =
        /charset="?([\w-]+)/i.exec(header(partHead, "Content-Type") ?? "")?.[1] ?? "utf-8";
      page = new TextDecoder(charset).decode(raw);
      base = location ?? "";
      continue;
    }
    const resource = { type, bytes: raw };
    if (location) resources.set(location, resource);
    if (id) resources.set(`cid:${id}`, resource);
  }
  if (page === undefined) throw new Error("This MHTML file has no web page in it.");
  return { page, base, resources };
}

// ---------------------------------------------------------------------------- saved folders

/** The page of a zipped "Webpage, Complete" folder and the files beside it, by relative path. */
export async function readSavedFolder(
  bytes: Uint8Array,
): Promise<{ page: string; base: string; resources: Resources }> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(
    (f) => !f.dir && !/(^|\/)(__MACOSX|\._)/.test(f.name),
  );
  const pages = files
    .filter((f) => /\.x?html?$/i.test(f.name))
    .toSorted(
      (a, b) =>
        a.name.split("/").length - b.name.split("/").length || a.name.length - b.name.length,
    );
  if (!pages.length) throw new Error("The zip has no HTML page in it.");
  const resources: Resources = new Map();
  for (const file of files) {
    resources.set(`zip:/${file.name}`, {
      type: mime.getType(file.name) ?? "application/octet-stream",
      bytes: await file.async("uint8array"),
    });
  }
  return {
    page: decode(await pages[0].async("uint8array")),
    base: `zip:/${pages[0].name}`,
    resources,
  };
}

// ---------------------------------------------------------------------------- inlining

/** The resource a reference points at, from the place it is written in. */
function lookup(resources: Resources, ref: string, from: string) {
  const clean = ref.trim().replace(/^['"]|['"]$/g, "");
  if (!clean || /^(data:|#|javascript:|about:)/i.test(clean)) return undefined;
  if (resources.has(clean)) return resources.get(clean);
  try {
    // zip:/ isn't a scheme URL knows how to resolve against, so stand in a real one for it
    const base = from.startsWith("zip:/") ? `http://zip.invalid/${from.slice(5)}` : from;
    const url = new URL(clean, base || "http://page.invalid/");
    const key =
      url.host === "zip.invalid"
        ? `zip:/${decodeURIComponent(url.pathname.slice(1))}`
        : url.href.split("#")[0];
    return resources.get(key) ?? resources.get(decodeURIComponent(key));
  } catch {
    return undefined;
  }
}

const dataUrl = (r: { type: string; bytes: Uint8Array }) =>
  `data:${r.type};base64,${toBase64(r.bytes)}`;

/** CSS with its url()s and @imports inlined, down to `depth` levels of imports. */
export function inlineCss(css: string, from: string, resources: Resources, depth = 4): string {
  return css
    .replace(
      /@import\s+(?:url\()?\s*(['"]?)([^'")\s]+)\1\s*\)?\s*([^;]*);/g,
      (all, _q, ref: string) => {
        const found = lookup(resources, ref, from);
        if (!found || depth <= 0) return "";
        return inlineCss(decode(found.bytes), resolveKey(ref, from), resources, depth - 1);
      },
    )
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, _q, ref: string) => {
      const found = lookup(resources, ref, from);
      if (!found) return /^data:/i.test(ref.trim()) ? all : "url()";
      if (found.type === "text/css") {
        return `url("data:text/css;base64,${toBase64(encode(inlineCss(decode(found.bytes), resolveKey(ref, from), resources, depth - 1)))}")`;
      }
      return `url("${dataUrl(found)}")`;
    });
}

/** Where a reference sits, as a base for what it refers to in turn. */
function resolveKey(ref: string, from: string): string {
  try {
    const base = from.startsWith("zip:/") ? `http://zip.invalid/${from.slice(5)}` : from;
    const url = new URL(ref, base || "http://page.invalid/");
    return url.host === "zip.invalid"
      ? `zip:/${decodeURIComponent(url.pathname.slice(1))}`
      : url.href;
  } catch {
    return from;
  }
}

/**
 * A saved page as one HTML file: every picture, style sheet, font and frame inside it as a
 * data: URL, and no script left, so it opens the same in years and sends nothing anywhere.
 */
export function inlinePage(
  html: string,
  base: string,
  resources: Resources,
): { html: string; missing: number } {
  // linkedom's own types are looser than the DOM it implements
  const document = new DOMParser().parseFromString(html, "text/html") as unknown as Document;
  let missing = 0;
  const inlineAttr = (el: Element, attr: string) => {
    const ref = el.getAttribute(attr);
    if (!ref || /^data:/i.test(ref)) return;
    const found = lookup(resources, ref, base);
    if (found) el.setAttribute(attr, dataUrl(found));
    else {
      missing++;
      el.removeAttribute(attr);
    }
  };

  for (const el of document.querySelectorAll("script, noscript, base, meta[http-equiv]"))
    el.remove();
  for (const el of document.querySelectorAll("*")) {
    // a copy: removing an attribute changes the live list
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value))
        el.removeAttribute(attr.name);
    }
    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", inlineCss(style, base, resources));
  }
  for (const link of document.querySelectorAll("link")) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    const found = lookup(resources, link.getAttribute("href") ?? "", base);
    if (rel.includes("stylesheet") && found) {
      const style = document.createElement("style");
      const media = link.getAttribute("media");
      if (media) style.setAttribute("media", media);
      style.textContent = inlineCss(
        decode(found.bytes),
        resolveKey(link.getAttribute("href")!, base),
        resources,
      );
      link.replaceWith(style);
    } else if (/\bicon\b/.test(rel) && found) link.setAttribute("href", dataUrl(found));
    else link.remove();
  }
  for (const style of document.querySelectorAll("style")) {
    style.textContent = inlineCss(style.textContent ?? "", base, resources);
  }
  for (const el of document.querySelectorAll(
    "img, source, video, audio, track, input[type=image], embed",
  )) {
    inlineAttr(el, "src");
    if (el.hasAttribute("poster")) inlineAttr(el, "poster");
    const srcset = el.getAttribute("srcset");
    if (srcset) {
      // the largest candidate alone: a srcset of data URLs would hold every size twice over
      const best = srcset
        .split(",")
        .map((s: string) => s.trim().split(/\s+/))
        .at(-1)?.[0];
      el.removeAttribute("srcset");
      if (best && !el.getAttribute("src")) {
        el.setAttribute("src", best);
        inlineAttr(el, "src");
      }
    }
  }
  for (const frame of document.querySelectorAll("iframe, frame")) {
    const found = lookup(resources, frame.getAttribute("src") ?? "", base);
    if (found && found.type === "text/html") {
      const inner = inlinePage(
        decode(found.bytes),
        resolveKey(frame.getAttribute("src")!, base),
        resources,
      );
      frame.setAttribute("src", `data:text/html;base64,${toBase64(encode(inner.html))}`);
      missing += inner.missing;
    } else frame.removeAttribute("src");
  }
  for (const svgImage of document.querySelectorAll("image")) {
    if (svgImage.hasAttribute("href")) inlineAttr(svgImage, "href");
    if (svgImage.hasAttribute("xlink:href")) inlineAttr(svgImage, "xlink:href");
  }
  // links keep working as links to the page on the internet
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")!;
    if (base && !/^(#|data:|mailto:)/i.test(href) && !base.startsWith("zip:/")) {
      try {
        a.setAttribute("href", new URL(href, base).href);
      } catch {
        // left as it was
      }
    }
  }

  const head = document.querySelector("head") ?? document.documentElement;
  const csp = document.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", ARCHIVE_CSP);
  head.prepend(csp);
  if (!document.querySelector("meta[charset]")) {
    const charset = document.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    head.prepend(charset);
  }
  if (base && !base.startsWith("zip:/")) {
    head.append(document.createComment(` saved from ${base.replaceAll("--", "- -")} `));
  }
  return { html: "<!doctype html>\n" + document.documentElement.outerHTML, missing };
}

/** Saves a web page as one HTML file, from MHTML or a zipped "Webpage, Complete" folder. */
class archiveHandler implements FormatHandler {
  public readonly name = "archive";
  public supportedFormats = [
    MHTML.builder("mhtml").from(),
    Formats.ZIP.builder("zip").from(),
    ARCHIVED_PAGE.builder("html").to(),
  ];
  public ready = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    _outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const outputs: FileData[] = [];
    for (const [i, file] of inputFiles.entries()) {
      ctx?.progress(`Packing ${file.name} into one page...`, i / inputFiles.length);
      const saved =
        inputFormat.internal === "mhtml"
          ? parseMhtml(file.bytes)
          : await readSavedFolder(file.bytes);
      const { html, missing } = inlinePage(saved.page, saved.base, saved.resources);
      if (missing)
        ctx?.log(`${file.name}: ${missing} files the page refers to were not saved with it.`);
      outputs.push({ name: changeExt(file.name, "html", "-archived"), bytes: encode(html) });
    }
    return outputs;
  }
}

export default archiveHandler;
