import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  platform: "neutral",
  treeshake: true,
  // Keep `node:` specifiers: Deno and edge bundlers resolve them, bare "crypto" they do not.
  removeNodeProtocol: false,
  external: [/^node:/],
});
