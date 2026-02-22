import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/middy.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  target: "node18",
  external: ["mitm"],
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
});
