import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_RUST_TARGET = "x86_64-unknown-linux-musl";

export type CompileTarget = {
  target: string;
  cargoExecutable: string;
  releaseName: string;
  checksumName: string;
};

export function parseCompileTarget(args: string[], env: Record<string, string | undefined>): string {
  let target = env.SHELT_RUST_TARGET || DEFAULT_RUST_TARGET;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--target") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--target requires a Rust target triple");
      target = value;
      index++;
    } else if (argument.startsWith("--target=")) {
      const value = argument.slice("--target=".length);
      if (!value) throw new Error("--target requires a Rust target triple");
      target = value;
    } else {
      throw new Error(`Unknown compile argument: ${argument}`);
    }
  }
  return target;
}

export function compileTarget(root: string, target: string, cargoTargetDir?: string): CompileTarget {
  const releaseName = releaseNameForTarget(target);
  const targetDir = cargoTargetDir
    ? isAbsolute(cargoTargetDir) ? cargoTargetDir : resolve(root, cargoTargetDir)
    : join(root, "target");
  return {
    target,
    cargoExecutable: join(targetDir, target, "release", "shelt"),
    releaseName,
    checksumName: `${releaseName}.sha256`,
  };
}

export function releaseNameForTarget(target: string): string {
  if (target === "x86_64-unknown-linux-musl") return "shelt-linux-x86_64-musl";
  if (target === "aarch64-apple-darwin") return "shelt-macos-aarch64";
  return `shelt-${target}`;
}
