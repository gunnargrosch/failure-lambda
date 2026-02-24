import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

export default defineConfig([
  {
    entry: ["src/index.ts", "src/middy.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    outDir: "dist",
    splitting: false,
    sourcemap: true,
    target: "node20",
    cjsInterop: true,
    esbuildOptions(options, context) {
      if (context.format === "cjs") {
        // Ensure require('failure-lambda') returns the function directly
        // while still exposing named exports as properties
        options.footer = {
          js: `if (module.exports.default) { Object.assign(module.exports.default, module.exports); module.exports = module.exports.default; }`,
        };
      }
    },
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: false,
    outDir: "dist",
    sourcemap: true,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
    define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
  },
]);
