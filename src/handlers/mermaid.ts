import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import Formats from "src/Formats.ts";
import { changeExt, decode, encode } from "src/common/index.ts";
import type { Mermaid } from "mermaid";

/**
 * Gives the drawing the size of its viewBox instead of "100%" of a page it no longer sits in,
 * so that it opens at its own size and can be turned into a PNG.
 */
export function fixSvgSize(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/, (tag) => {
    const viewBox = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(tag);
    if (!viewBox) return tag;
    const [, width, height] = viewBox;
    return tag
      .replace(/ width="[^"]*"/, "")
      .replace(/ height="[^"]*"/, "")
      .replace(/ style="[^"]*"/, "")
      .replace("<svg", `<svg width="${width}" height="${height}"`);
  });
}

let loading: Promise<Mermaid> | undefined;

/** mermaid, set up the way this app draws with it: no script, SVG text, dagre layout. */
export function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // no script, links or HTML from the diagram
      securityLevel: "strict",
      // labels as SVG text: HTML inside an SVG can't be drawn on a canvas, which PNG needs
      htmlLabels: false,
      // mermaid 12 lays out with ELK by default, which is left out (src/handlers/mermaid/noElk.ts)
      layout: "dagre",
    });
    return mermaid;
  });
  loading.catch(() => (loading = undefined));
  return loading;
}

let renders = 0;

/** A diagram drawn as SVG at its own size. Throws mermaid's own message when the code is wrong. */
export async function renderMermaid(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const { svg } = await mermaid.render(`mermaid-${Date.now()}-${renders++}`, code);
  return fixSvgSize(svg);
}

/** Draws Mermaid diagrams as SVG. */
class mermaidHandler implements FormatHandler {
  public readonly name = "mermaid";
  public supportedFormats = [
    Formats.MERMAID.builder("mermaid").from(),
    Formats.SVG.builder("svg").to(),
  ];
  public ready = false;
  public offload = false; // mermaid measures its text in the page

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    _outputFormat: FileFormat,
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];
    for (const file of inputFiles) {
      outputFiles.push({
        name: changeExt(file.name, "svg"),
        bytes: encode(await renderMermaid(decode(file.bytes))),
      });
    }
    return outputFiles;
  }
}

export default mermaidHandler;
