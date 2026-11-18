/**
 * A small Markdown renderer for the pages this app writes (slides, boards): headings, lists
 * with task boxes, quotes, code, tables, rules, emphasis, links and images. Everything is
 * escaped first, so a note can't put HTML or script into the page. Links keep only http(s),
 * mailto and # targets; images only data: URLs, because the pages work offline.
 */

export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const safeLink = (url: string) => /^(https?:|mailto:|#)/i.test(url);
const safeImage = (url: string) => /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(url);

/** Inline Markdown of one line or paragraph, already escaped. */
export function inline(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  out = out
    .replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, alt: string, url: string) =>
      safeImage(url) ? `<img alt="${alt}" src="${url}">` : alt,
    )
    .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, label: string, url: string) =>
      safeLink(url.replaceAll("&amp;", "&")) ? `<a href="${url}">${label}</a>` : label,
    )
    .replace(
      /\*\*([^*]+)\*\*|__([^_]+)__/g,
      (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`,
    )
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/==([^=]+)==/g, "<mark>$1</mark>");
  return out.replace(/\uE000(\d+)\uE000/g, (_, i: string) => codes[Number(i)]);
}

/** Front matter (--- at the very top) is metadata, not content. */
export function stripFrontMatter(text: string): string {
  return text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** The cells of a table row. */
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Block Markdown to HTML. */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpExecArray | null;

    if (/^\s*$/.test(line)) {
      flush();
      i++;
    } else if ((m = /^(```|~~~)\s*([\w+-]*)/.exec(line))) {
      flush();
      const fence = m[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) body.push(lines[i++]);
      i++;
      const lang = m[2] ? ` class="language-${escapeHtml(m[2])}"` : "";
      html.push(`<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush();
      html.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      html.push("<hr>");
      i++;
    } else if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ""));
      html.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        const task = /^\[(.)\]\s+(.*)$/.exec(item);
        if (task) {
          const checked = task[1].toLowerCase() === "x" ? " checked" : "";
          items.push(
            `<li class="task"><input type="checkbox" disabled${checked}> ${inline(task[2])}</li>`,
          );
        } else items.push(`<li>${inline(item)}</li>`);
      }
      html.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-+/.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>",
      );
    } else {
      paragraph.push(line.trim());
      i++;
    }
  }
  flush();
  return html.join("\n");
}
