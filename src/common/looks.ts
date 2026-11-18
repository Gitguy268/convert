/**
 * The four looks the pages this app writes can wear (slides, boards, theme packs): plain,
 * Windows 98, liquid glass and Xiao, the same set as textarea's `data-look`. Each is plain CSS
 * on a few class names, so a page needs nothing from outside to look right offline.
 *
 * Classes: `.surface` (behind everything), `.panel` (a card, a slide, a window), `.titlebar`
 * (a panel's head), `.muted`, `.chip`, and `button`.
 */

export const LOOK_IDS = {
  plain: "classic",
  Win98: "win97",
  "liquid glass": "glass",
  Xiao: "xiao",
} as const;
export type LookName = keyof typeof LOOK_IDS;

export const isLook = (value: unknown): value is LookName =>
  typeof value === "string" && Object.hasOwn(LOOK_IDS, value);

export interface Palette {
  /** Buttons, links, the active state. */
  accent: string;
  /** One to three colours behind everything, as a gradient. */
  background: string[];
}

export const DEFAULT_PALETTE: Palette = { accent: "#2f6fed", background: ["#8ec5fc", "#e0c3fc"] };

const gradient = (colours: string[], angle = 135) =>
  colours.length > 1
    ? `linear-gradient(${angle}deg, ${colours.join(", ")})`
    : (colours[0] ?? "#ffffff");

/** CSS custom properties of a palette, for `:root`. */
export function paletteVariables(p: Palette): string {
  return [
    `--accent: ${p.accent};`,
    `--bg-1: ${p.background[0] ?? p.accent};`,
    `--bg-2: ${p.background[1] ?? p.background[0] ?? p.accent};`,
    `--bg-3: ${p.background[2] ?? p.background[1] ?? p.background[0] ?? p.accent};`,
    `--bg: ${gradient(p.background)};`,
  ].join(" ");
}

const BASE = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { font: 16px/1.5 var(--font); color: var(--text); }
.surface { min-height: 100vh; background: var(--surface); }
a { color: var(--link, var(--accent)); }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; }
pre { overflow: auto; padding: 0.8em 1em; background: var(--code-bg); border-radius: var(--radius-small); }
img { max-width: 100%; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--line); padding: 0.3em 0.6em; text-align: left; }
blockquote { margin: 0; padding-left: 1em; border-left: 3px solid var(--accent); color: var(--muted); }
.muted { color: var(--muted); }
.chip { display: inline-block; padding: 0 0.5em; border-radius: 999px; font-size: 0.8em; background: var(--chip-bg); color: var(--chip-text); }
button { font: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const LOOK_CSS: Record<LookName, string> = {
  plain: `
:root { --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --text: #161616; --muted: #5c5c66;
  --surface: #f4f4f6; --panel: #ffffff; --line: #dcdce2; --code-bg: #f0f0f3; --chip-bg: #eceef3; --chip-text: #33343a;
  --radius: 14px; --radius-small: 8px; --link: color-mix(in srgb, var(--accent) 80%, black); }
@media (prefers-color-scheme: dark) { :root { --text: #f2f2f4; --muted: #a4a4ae; --surface: #101012; --panel: #1b1b1f;
  --line: #34343a; --code-bg: #24242a; --chip-bg: #2a2a31; --chip-text: #e4e4ea; --link: color-mix(in srgb, var(--accent) 70%, white); } }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 1px 3px rgb(0 0 0 / 0.08); }
.titlebar { font-weight: 600; padding: 0.6em 1em; border-bottom: 1px solid var(--line); }
button { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: var(--radius-small); padding: 0.35em 0.8em; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
`,
  Win98: `
:root { --font: Tahoma, "MS Sans Serif", Geneva, Verdana, sans-serif; --text: #000000; --muted: #404040;
  --surface: #008080; --panel: #c0c0c0; --line: #808080; --code-bg: #ffffff; --chip-bg: #ffffff; --chip-text: #000000;
  --radius: 0; --radius-small: 0; --link: #0000ee; }
body { font-size: 13px; }
.panel { background: var(--panel); border: 2px solid; border-color: #ffffff #404040 #404040 #ffffff;
  box-shadow: inset -1px -1px #808080, inset 1px 1px #dfdfdf; }
.titlebar { background: linear-gradient(90deg, #000080, #1084d0); color: #ffffff; font-weight: bold; padding: 3px 6px; margin: 2px; }
.chip { border-radius: 0; border: 1px solid #808080; }
pre, th, td { border: 1px solid #808080; }
button { background: #c0c0c0; color: #000; border: 2px solid; border-color: #ffffff #404040 #404040 #ffffff;
  box-shadow: inset -1px -1px #808080, inset 1px 1px #dfdfdf; padding: 3px 12px; border-radius: 0; }
button:active { border-color: #404040 #ffffff #ffffff #404040; box-shadow: inset 1px 1px #808080; }
button.primary { outline: 1px solid #000; }
:focus-visible { outline: 1px dotted #000; outline-offset: -4px; }
`,
  "liquid glass": `
:root { --font: -apple-system, "SF Pro Text", system-ui, "Segoe UI", sans-serif; --text: #101018; --muted: #3c3c4a;
  --surface: var(--bg); --panel: rgb(255 255 255 / 0.32); --line: rgb(255 255 255 / 0.55); --code-bg: rgb(255 255 255 / 0.45);
  --chip-bg: rgb(255 255 255 / 0.55); --chip-text: #14141c; --radius: 24px; --radius-small: 14px;
  --link: color-mix(in srgb, var(--accent) 75%, black); }
@media (prefers-color-scheme: dark) { :root { --text: #f6f6fa; --muted: #d0d0dc; --panel: rgb(20 20 28 / 0.42);
  --line: rgb(255 255 255 / 0.22); --code-bg: rgb(0 0 0 / 0.3); --chip-bg: rgb(255 255 255 / 0.16); --chip-text: #f6f6fa;
  --link: color-mix(in srgb, var(--accent) 55%, white); } }
.surface { background: var(--bg); background-attachment: fixed; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  -webkit-backdrop-filter: blur(24px) saturate(180%); backdrop-filter: blur(24px) saturate(180%);
  box-shadow: 0 10px 40px rgb(0 0 0 / 0.18), inset 0 1px 0 rgb(255 255 255 / 0.6); }
.titlebar { font-weight: 600; padding: 0.7em 1.1em; border-bottom: 1px solid var(--line); }
button { border: 1px solid var(--line); background: var(--chip-bg); color: var(--text); border-radius: 999px; padding: 0.4em 1em;
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
button.primary { background: var(--accent); color: #fff; border-color: transparent; }
@media (prefers-reduced-transparency: reduce) { .panel, button { backdrop-filter: none; -webkit-backdrop-filter: none; }
  .panel { background: #f4f4f8; } }
`,
  Xiao: `
:root { --font: "Bricolage Grotesque", "Avenir Next", "Helvetica Neue", sans-serif; --text: #2a1d17; --muted: #6e5a4e;
  --surface: #f3ecdf; --panel: #fbf7ef; --line: #d9ccb8; --code-bg: #efe6d6; --chip-bg: #f1e1d6; --chip-text: #8f1f17;
  --radius: 6px; --radius-small: 4px; --accent: #b3261e; --link: #9b1c14; }
@media (prefers-color-scheme: dark) { :root { --text: #f1e8dc; --muted: #c4b29f; --surface: #1d1714; --panel: #27201b;
  --line: #4a3d33; --code-bg: #312822; --chip-bg: #3a2620; --chip-text: #ffb4a8; --accent: #ff8a7a; --link: #ff9c8d; } }
h1, h2, h3, h4 { font-family: "Junicode", "Iowan Old Style", Georgia, serif; font-weight: 700; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 3px 3px 0 var(--line); }
.titlebar { font-family: "Junicode", Georgia, serif; font-weight: 700; padding: 0.6em 1em; border-bottom: 2px solid var(--accent); }
button { border: 1px solid var(--text); background: transparent; color: var(--text); border-radius: var(--radius-small); padding: 0.35em 0.9em; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
`,
};

/** The whole stylesheet of a look, with the palette's colours where the look uses them. */
export function lookCss(look: LookName, palette: Palette = DEFAULT_PALETTE): string {
  // Xiao keeps its own red ink and Windows 98 its navy: the palette only fills their gaps
  const accent = look === "Win98" || look === "Xiao" ? "" : `--accent: ${palette.accent};`;
  const vars = `:root { ${paletteVariables(palette)} } :root { ${accent} }`;
  return `${vars}\n${LOOK_CSS[look]}\n${BASE}`;
}
