// N4: the published tarball holds dist/, README.md, LICENSE (and package.json, which npm always adds).
import { execFileSync } from "node:child_process";

const [{ files }] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const bad = files.map((f) => f.path).filter((p) => !(p.startsWith("dist/") || ["README.md", "LICENSE", "package.json"].includes(p)));
console.log(files.map((f) => `${f.path} ${f.size}`).join("\n"));
if (bad.length) {
  console.error(`unexpected files in the tarball: ${bad.join(", ")}`);
  process.exit(1);
}
