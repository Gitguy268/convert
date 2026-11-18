// Opened straight from disk, a browser blocks the page's own module scripts, workers and
// WebAssembly. Say so, where the page would otherwise stay blank. A file of its own, because
// the Content-Security-Policy allows no inline scripts.
if (location.protocol === "file:") {
  document.write(
    '<body style="font: 16px/1.5 system-ui, sans-serif; margin: 3em auto; max-width: 34em; padding: 0 1em">' +
      "<h1>This app can't run from a file</h1>" +
      "<p>Double-click <b>start.command</b> in the project folder (macOS), " +
      "or run <code>bun run start</code> there. Both open the app at a web address.</p>",
  );
}
