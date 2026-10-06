// N1: min+gzip size of the client as a consumer bundles it (ESM entry, all namespaces).
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

const LIMIT = 60 * 1024;
const out = await build({
  entryPoints: [new URL("../dist/index.js", import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "neutral",
  write: false,
  external: ["node:*"],
});
const bytes = out.outputFiles[0].contents;
const gz = gzipSync(bytes).length;
console.log(`bundle: ${bytes.length} B min, ${gz} B min+gzip (${(gz / 1024).toFixed(1)} kB; limit 60 kB)`);
if (gz > LIMIT) process.exit(1);
