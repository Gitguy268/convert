import { defineConfig } from "oxfmt";

export const ignorePatterns = [
  ".github/**",
  "built/**",
  "src/handlers/index.ts",
  "src/ui/popularity.json",
  "test/resources/**",
  // vendored and minified, with a local patch (public/vendor/wllama/README.md)
  "public/vendor/**",
  // generated from the model files (src/localModels/README.md)
  "src/localModels/models.json",
];

export default defineConfig({ ignorePatterns });
