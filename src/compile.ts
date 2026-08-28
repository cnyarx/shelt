import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { compileTarget, parseCompileTarget } from "./compile-target.ts";

const root = join(import.meta.dir, "..");
const release = join(root, "release");
const cargo = Bun.which("cargo") || join(process.env.HOME || ".", ".cargo/bin/cargo");
const target = compileTarget(
  root,
  parseCompileTarget(Bun.argv.slice(2), process.env),
  process.env.CARGO_TARGET_DIR,
);

await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });

const buildProcess = Bun.spawn([cargo, "build", "--release", "--target", target.target], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await buildProcess.exited;
if (exitCode !== 0) process.exit(exitCode);

const executable = join(release, target.releaseName);
await copyFile(target.cargoExecutable, executable);
await chmod(executable, 0o755);
const checksum = createHash("sha256").update(new Uint8Array(await Bun.file(executable).arrayBuffer())).digest("hex");
await writeFile(join(release, target.checksumName), `${checksum}  ${target.releaseName}\n`);
console.log(`Built Rust standalone Shelt executable: ${executable}`);
