import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_RUST_TARGET,
  compileTarget,
  parseCompileTarget,
  releaseNameForTarget,
} from "../src/compile-target.ts";

describe("standalone compile target", () => {
  test("defaults Linux releases to the static musl target", () => {
    expect(parseCompileTarget([], {})).toBe(DEFAULT_RUST_TARGET);
    expect(releaseNameForTarget(DEFAULT_RUST_TARGET)).toBe("shelt-linux-x86_64-musl");
  });

  test("supports environment and command-line target overrides", () => {
    expect(parseCompileTarget([], { SHELT_RUST_TARGET: "aarch64-unknown-linux-musl" })).toBe("aarch64-unknown-linux-musl");
    expect(parseCompileTarget(["--target", "x86_64-unknown-linux-gnu"], {})).toBe("x86_64-unknown-linux-gnu");
    expect(parseCompileTarget(["--target=x86_64-unknown-linux-gnu"], {})).toBe("x86_64-unknown-linux-gnu");
  });

  test("uses the target-specific Cargo output path and explicit release names", () => {
    const target = compileTarget("/project", DEFAULT_RUST_TARGET);
    expect(target.cargoExecutable).toBe(join("/project", "target", DEFAULT_RUST_TARGET, "release", "shelt"));
    expect(target.releaseName).toBe("shelt-linux-x86_64-musl");
    expect(target.checksumName).toBe("shelt-linux-x86_64-musl.sha256");
    expect(releaseNameForTarget("aarch64-apple-darwin")).toBe("shelt-macos-aarch64");
    expect(releaseNameForTarget("aarch64-unknown-linux-musl")).toBe("shelt-aarch64-unknown-linux-musl");
  });

  test("respects relative and absolute Cargo target directories", () => {
    expect(compileTarget("/project", DEFAULT_RUST_TARGET, "build-target").cargoExecutable).toBe(
      join("/project", "build-target", DEFAULT_RUST_TARGET, "release", "shelt"),
    );
    expect(compileTarget("/project", DEFAULT_RUST_TARGET, "/cache/target").cargoExecutable).toBe(
      join("/cache/target", DEFAULT_RUST_TARGET, "release", "shelt"),
    );
  });

  test("rejects missing or unknown compile arguments", () => {
    expect(() => parseCompileTarget(["--target"], {})).toThrow("--target requires");
    expect(() => parseCompileTarget(["--target="], {})).toThrow("--target requires");
    expect(() => parseCompileTarget(["--release"], {})).toThrow("Unknown compile argument");
  });
});
