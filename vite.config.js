import { defineConfig, normalizePath } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import securityHeaders from "./src/securityHeaders.cjs";

const excludedHandlers =
  process.env.IS_DESKTOP === "true" || !existsSync(new URL("./built/clang", import.meta.url))
    ? ["clang"]
    : [];
const excludedHandlerFiles = excludedHandlers.map((name) =>
  normalizePath(fileURLToPath(new URL(`./src/handlers/${name}.ts`, import.meta.url))),
);

const excludeHandlers = {
  name: "exclude-handlers",
  enforce: "pre",
  load(id) {
    if (excludedHandlerFiles.includes(id)) return "export {};";
  },
};

export default defineConfig({
  define: { __EXCLUDED_HANDLERS__: JSON.stringify(excludedHandlers) },
  server: { headers: securityHeaders, watch: { ignored: ["**/.cache/**"] } },
  preview: { headers: securityHeaders },
  publicDir: "public",
  optimizeDeps: {
    include: ["turbowarp-packager", "turbowarp-unpackager"],
    exclude: ["@ffmpeg/ffmpeg", "@sqlite.org/sqlite-wasm", "@bokuweb/zstd-wasm", "@jsquash/oxipng"],
  },
  base: "./",
  worker: {
    format: "es",
    plugins: () => [excludeHandlers],
  },
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "turbowarp-packager",
        replacement: fileURLToPath(
          new URL("./built/turbowarp-packager/packager.js", import.meta.url),
        ),
      },
      {
        find: "turbowarp-unpackager",
        replacement: fileURLToPath(
          new URL("./built/turbowarp-unpackager/unpackager.js", import.meta.url),
        ),
      },
      { find: "built", replacement: fileURLToPath(new URL("./built", import.meta.url)) },
      {
        // mermaid's optional ELK layout is EPL-2.0, a copyleft licence: build without it
        find: /^elkjs\/lib\/elk\.bundled\.js$/,
        replacement: fileURLToPath(new URL("./src/handlers/mermaid/noElk.ts", import.meta.url)),
      },
      {
        // the package's own bundle is a webpack development build made of eval() calls, which
        // minifying breaks. Its TypeScript source is in the package too and builds cleanly.
        find: /^@websr\/websr$/,
        replacement: fileURLToPath(
          new URL("./node_modules/@websr/websr/src/main.ts", import.meta.url),
        ),
      },
    ],
  },
  plugins: [
    excludeHandlers,
    viteStaticCopy({
      targets: [
        {
          src: "built/espeakng.js/js/espeakng.worker.js",
          dest: "external/espeakng.js/",
        },
        {
          src: "built/espeakng.js/js/espeakng.worker.data",
          dest: "external/espeakng.js/",
        },
        {
          src: "node_modules/pdfjs-dist/{standard_fonts,cmaps,wasm}",
          dest: "external/pdfjs/",
        },
        {
          src: "built/typst-assets/files/fonts/*",
          dest: "external/typst/",
        },
        {
          // only the LSTM cores: the OCR handler never asks for the legacy engine
          src: [
            "node_modules/tesseract.js/dist/worker.min.js",
            "node_modules/tesseract.js-core/tesseract-core{,-simd,-relaxedsimd}-lstm.wasm.js",
            "node_modules/@tesseract.js-data/{eng,nld}/4.0.0_best_int/*.traineddata.gz",
          ],
          dest: "external/tesseract/",
        },
        {
          // loaded by "Check audio" with audioWorklet.addModule, which needs a file of its own
          src: "node_modules/loudness-worklet/packages/lib/dist/loudness.worklet.js",
          dest: "external/loudness/",
        },
      ],
    }),
    {
      // without the format cache, every dev page load initialises all handlers (about 270 MB)
      name: "serve-format-cache",
      configureServer(server) {
        server.middlewares.use("/cache.json", (_req, res, next) => {
          if (!existsSync("dist/cache.json")) return next();
          res.setHeader("Content-Type", "application/json");
          createReadStream("dist/cache.json").pipe(res);
        });
      },
    },
    {
      // index.html ends with an inline script that sends a plain file server to the build
      // (see there). It has nothing to do in the build itself, whose CSP blocks inline scripts.
      name: "drop-source-page-script",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler: (html) =>
          html.replace(/\n\s*<script>\s*\/\/ A plain file server[\s\S]*?<\/script>/, ""),
      },
    },
    preact({
      prefreshEnabled: false,
      reactAliasesEnabled: true,
    }),
  ],
});
