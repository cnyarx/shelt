import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const release = join(root, "release");
const cargo = Bun.which("cargo") || join(process.env.HOME || ".", ".cargo/bin/cargo");

await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });

const buildProcess = Bun.spawn([cargo, "build", "--release"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await buildProcess.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

const executable = join(release, "shelt");
await copyFile(join(root, "target/release/shelt"), executable);
await chmod(executable, 0o755);
console.log(`Built Rust standalone Shelt executable: ${executable}`);
