import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/client.ts"), join(root, "src/preview.ts")],
  outdir: dist,
  target: "browser",
  minify: true,
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await cp(join(root, "public/index.html"), join(dist, "index.html"));
await cp(join(root, "public/style.css"), join(dist, "style.css"));
await cp(join(root, "public/preview.html"), join(dist, "preview.html"));
await cp(join(root, "public/preview.css"), join(dist, "preview.css"));
for (const favicon of ["favicon.png", "favicon-16.png", "favicon-32.png", "favicon-64.png"]) {
  await cp(join(root, "public", favicon), join(dist, favicon));
}
for (const js of ["client.js", "preview.js"]) {
  const raw = await readFile(join(dist, js));
  const gz = gzipSync(raw, { level: 9 });
  await writeFile(join(dist, `${js}.gz`), gz);
}
console.log("Built Shelt web client");
