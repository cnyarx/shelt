import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { buildVersion } from "./build-version.ts";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
};
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
if (process.env.SHELT_RELEASE_TAG && process.env.SHELT_BUILD_COMMIT !== commit) throw new Error("Release commit does not match checked-out source");
const version = buildVersion(commit, dirty, process.env.SHELT_RELEASE_TAG);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await writeFile(join(dist, "version.json"), JSON.stringify(version) + "\n");

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
for (const favicon of ["favicon.svg", "favicon.png", "favicon-16.png", "favicon-32.png", "favicon-64.png"]) {
  await cp(join(root, "public", favicon), join(dist, favicon));
}
for (const js of ["client.js", "preview.js"]) {
  const raw = await readFile(join(dist, js));
  const gz = gzipSync(raw, { level: 9 });
  await writeFile(join(dist, `${js}.gz`), gz);
}
console.log("Built Shelt web client");
