import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import Formats, { Category } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { changeExt, decode, encode, stripExt } from "src/common/index.ts";
import { escapeHtml, inline } from "src/common/markdown.ts";
import { isLook, lookCss, type LookName } from "src/common/looks.ts";

export const KANBAN = new FormatDefinition(
  "Kanban board (HTML, saves the note back)",
  "kanban",
  "html",
  "text/html",
  [Category.DOCUMENT, Category.TEXT],
);

/** The columns, with the status character Obsidian Tasks (and textarea-plus) writes for each. */
export const COLUMNS = [
  { char: " ", id: "todo", label: "Todo" },
  { char: "/", id: "doing", label: "In progress" },
  { char: "x", id: "done", label: "Done" },
  { char: "-", id: "cancelled", label: "Cancelled" },
] as const;

const TASK_LINE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[(.)\](.*)$/;
const PRIORITIES: Record<string, string> = {
  "🔺": "highest",
  "⏫": "high",
  "🔼": "medium",
  "🔽": "low",
  "⏬": "lowest",
};

export interface Card {
  /** Index of the line in the note. */
  line: number;
  column: (typeof COLUMNS)[number]["id"];
  text: string;
  section?: string;
  due?: string;
  priority?: string;
  tags: string[];
}

/** Every task line of a note as a card, in the order of the note. */
export function readCards(note: string): Card[] {
  const cards: Card[] = [];
  let section: string | undefined;
  let fenced = false;
  for (const [i, line] of note.replace(/\r\n?/g, "\n").split("\n").entries()) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading) section = heading[1];
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    const column = COLUMNS.find((c) => c.char === m[2].toLowerCase())?.id;
    if (!column) continue;
    let rest = m[3];
    const due = /📅️?\s*(\d{4}-\d{2}-\d{2})/u.exec(rest)?.[1];
    const priority = /([🔺⏫🔼🔽⏬])/u.exec(rest)?.[1];
    rest = rest
      .replace(/[📅⏳🛫➕✅❌]️?\s*\d{4}-\d{2}-\d{2}/gu, "")
      .replace(/⏰️?\s*\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2})?/u, "")
      .replace(/🔁️?[^📅⏳🛫➕✅❌🔺⏫🔼🔽⏬⏰\n]*/u, "")
      .replace(/[🔺⏫🔼🔽⏬]️?/gu, "")
      .replace(/\s+\^[\w-]+$/, "");
    const tags = [...rest.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((t) => t[1]);
    cards.push({
      line: i,
      column,
      text: rest
        .replace(/(?:^|\s)#[\p{L}\p{N}_/-]+/gu, "")
        .replace(/\s+/g, " ")
        .trim(),
      section,
      due,
      priority: priority && PRIORITIES[priority],
      tags,
    });
  }
  return cards;
}

/**
 * A task line moved to another column: only its status character changes, and the done date
 * that Obsidian Tasks writes is added or taken off with it. Runs in the board page too.
 */
export function moveLine(line: string, char: string, today: string): string {
  const m = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[(.)\](.*)$/.exec(line);
  if (!m) return line;
  let rest = m[3].replace(/[ \t]*✅️?[ \t]*\d{4}-\d{2}-\d{2}/u, "");
  if (char === "x") {
    const block = /[ \t]+\^[\w-]+$/.exec(rest);
    rest = block
      ? `${rest.slice(0, block.index)} ✅ ${today}${block[0]}`
      : `${rest.trimEnd()} ✅ ${today}`;
  }
  return `${m[1]}[${char}]${rest}`;
}

const BOARD_CSS = `
.board { display: grid; grid-template-columns: repeat(4, minmax(220px, 1fr)); gap: 16px; padding: 16px; align-items: start; min-height: 100vh; }
@media (max-width: 760px) { .board { grid-template-columns: 1fr; } }
header.top { display: flex; gap: 12px; align-items: center; padding: 16px 16px 0; flex-wrap: wrap; }
header.top h1 { margin: 0; font-size: 1.4em; flex: 1; }
.column { min-height: 120px; display: flex; flex-direction: column; }
.column .titlebar { display: flex; justify-content: space-between; }
.cards { list-style: none; margin: 0; padding: 10px; display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 60px; }
.cards.over { outline: 2px dashed var(--accent); outline-offset: -6px; }
.card { padding: 10px 12px; cursor: grab; }
.card[aria-grabbed="true"] { opacity: 0.5; }
.card .meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; font-size: 0.85em; }
.card .moves { display: flex; gap: 4px; justify-content: flex-end; margin-top: 6px; }
.card .moves button { padding: 0 8px; font-size: 0.85em; }
.column[data-column="done"] .text, .column[data-column="cancelled"] .text { text-decoration: line-through; opacity: 0.75; }
.priority-highest, .priority-high { background: #fde2e1; color: #8a1712; }
`;

const BOARD_SCRIPT = `
const data = JSON.parse(document.getElementById("note").textContent);
const lines = data.lines;
const chars = { todo: " ", doing: "/", done: "x", cancelled: "-" };
const order = ["todo", "doing", "done", "cancelled"];
const today = () => new Date().toLocaleDateString("sv-SE");
const moveLine = ${moveLine.toString()};
let changed = false;
function counts() {
  for (const col of document.querySelectorAll(".column")) col.querySelector(".count").textContent = col.querySelectorAll(".card").length;
  document.querySelector(".state").textContent = changed ? "Not saved" : "";
}
function move(card, columnId, before) {
  const list = document.querySelector('.column[data-column="' + columnId + '"] .cards');
  list.insertBefore(card, before || null);
  const i = Number(card.dataset.line);
  const next = moveLine(lines[i], chars[columnId], today());
  if (next !== lines[i]) { lines[i] = next; changed = true; }
  counts();
}
let dragged = null;
for (const card of document.querySelectorAll(".card")) {
  card.addEventListener("dragstart", (e) => { dragged = card; card.setAttribute("aria-grabbed", "true"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", card.dataset.line); });
  card.addEventListener("dragend", () => { card.setAttribute("aria-grabbed", "false"); dragged = null; });
  card.querySelector(".left").onclick = () => { const c = card.closest(".column").dataset.column; const i = order.indexOf(c); if (i > 0) { move(card, order[i - 1]); card.querySelector(".left").focus(); } };
  card.querySelector(".right").onclick = () => { const c = card.closest(".column").dataset.column; const i = order.indexOf(c); if (i < order.length - 1) { move(card, order[i + 1]); card.querySelector(".right").focus(); } };
}
for (const list of document.querySelectorAll(".cards")) {
  list.addEventListener("dragover", (e) => { if (!dragged) return; e.preventDefault(); list.classList.add("over"); });
  list.addEventListener("dragleave", () => list.classList.remove("over"));
  list.addEventListener("drop", (e) => {
    e.preventDefault(); list.classList.remove("over"); if (!dragged) return;
    const after = [...list.querySelectorAll(".card")].find((c) => c !== dragged && e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
    move(dragged, list.closest(".column").dataset.column, after);
  });
}
document.querySelector(".save").onclick = () => {
  const blob = new Blob([lines.join(data.newline)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = data.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  changed = false; counts();
};
addEventListener("beforeunload", (e) => { if (changed) e.preventDefault(); });
counts();
`;

/** One card of the board. */
function cardHtml(card: Card) {
  const meta = [
    card.section && `<span class="chip">${escapeHtml(card.section)}</span>`,
    card.due && `<span class="chip">📅 ${card.due}</span>`,
    card.priority && `<span class="chip priority-${card.priority}">${card.priority}</span>`,
    ...card.tags.map((tag) => `<span class="chip">#${escapeHtml(tag)}</span>`),
  ].filter(Boolean);
  return `<li class="card panel" draggable="true" data-line="${card.line}" tabindex="0">
<div class="text">${inline(card.text) || "&nbsp;"}</div>
${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
<div class="moves"><button class="left" aria-label="Move to the column on the left">←</button><button class="right" aria-label="Move to the column on the right">→</button></div>
</li>`;
}

/** The board as one HTML file, with the note inside it to save back. */
export function boardHtml(title: string, note: string, name: string, look: LookName): string {
  const newline = note.includes("\r\n") ? "\r\n" : "\n";
  const lines = note.replace(/\r\n?/g, "\n").split("\n");
  const cards = readCards(note);
  const columns = COLUMNS.map(
    (
      column,
    ) => `<section class="column panel" data-column="${column.id}" aria-label="${column.label}">
<div class="titlebar"><span>${column.label}</span><span class="count"></span></div>
<ul class="cards">${cards
      .filter((c) => c.column === column.id)
      .map(cardHtml)
      .join("")}</ul>
</section>`,
  ).join("\n");
  // < can't close the script element from inside the JSON
  const json = JSON.stringify({ lines, newline, name }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title>
<style>${lookCss(look)}${BOARD_CSS}</style>
</head>
<body class="surface">
<header class="top"><h1>${escapeHtml(title)}</h1><span class="state muted" aria-live="polite"></span><button class="save primary">Save ${escapeHtml(name)}</button></header>
<main class="board">
${columns}
</main>
<script type="application/json" id="note">${json}</script>
<script>${BOARD_SCRIPT}</script>
</body>
</html>
`;
}

/**
 * Shows the tasks of a textarea-plus note (Obsidian Tasks syntax) as a Kanban board. Moving a
 * card changes only its status character, so "Save" writes the same note back.
 */
class kanbanHandler implements FormatHandler {
  public readonly name = "kanban";
  public supportedFormats = [
    Formats.MD.builder("md").from(),
    Formats.TEXT.builder("text").from(),
    KANBAN.builder("html").options({ look: true }).to(),
  ];
  public ready = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    _outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const chosen = ctx?.options.look;
    const look: LookName = isLook(chosen) ? chosen : "plain";
    return inputFiles.map((file) => {
      const note = decode(file.bytes);
      if (!readCards(note).length) {
        throw new Error(`${file.name} has no task lines ("- [ ] something") to put on a board.`);
      }
      const title = /^#\s+(.+)$/m.exec(note)?.[1].trim() ?? stripExt(file.name);
      return {
        name: changeExt(file.name, "html", "-board"),
        bytes: encode(boardHtml(title, note, file.name, look)),
      };
    });
  }
}

export default kanbanHandler;
