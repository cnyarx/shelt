import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_TARGET_ID, TargetStore, targetError } from "../src/targets.ts";

function withStore(run: (store: TargetStore, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "shelt-targets-"));
  try {
    run(new TargetStore(join(directory, "herdr-targets.json")), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("target validation rejects injection and malformed values", () => {
  expect(targetError("开发机", "dev@10.0.0.2", null)).toBeNull();
  expect(targetError("home", "example.com", "work-1")).toBeNull();
  expect(targetError("home", "example.com", null)).toBeNull();
  expect(targetError("  ", "example.com", null)).not.toBeNull();
  expect(targetError("x".repeat(41), "example.com", null)).not.toBeNull();
  expect(targetError("x", "-oProxyCommand=evil", null)).not.toBeNull();
  expect(targetError("x", "host; rm -rf /", null)).not.toBeNull();
  expect(targetError("x", "host$(whoami)", null)).not.toBeNull();
  expect(targetError("x", "user@host", "-bad")).not.toBeNull();
  expect(targetError("x", "user@host", "has space")).not.toBeNull();
  expect(targetError("x", "user@host", "")).not.toBeNull();
});

test("target store lifecycle, permissions, persistence and active args", () => {
  withStore((store, directory) => {
    expect(store.active()).toBe(LOCAL_TARGET_ID);
    expect(store.activeArgs()).toEqual([]);
    const created = store.create(" 开发机 ", "dev@10.0.0.2", null);
    expect(created.name).toBe("开发机");
    expect(created.id).toMatch(/^[a-f0-9]{8}$/);
    const file = join(directory, "herdr-targets.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);

    expect(store.activate(created.id)).toBe(true);
    expect(store.activeArgs()).toEqual(["--remote", "dev@10.0.0.2"]);
    const updated = store.update(created.id, "开发机", "dev@10.0.0.2", "work");
    expect(updated?.session).toBe("work");

    const loaded = new TargetStore(file);
    expect(loaded.active()).toBe(created.id);
    expect(loaded.activeArgs()).toEqual(["--remote", "dev@10.0.0.2", "--session", "work"]);

    expect(loaded.activate("ffffffff")).toBe(false);
    expect(loaded.update("ffffffff", "x", "example.com", null)).toBeNull();
    expect(loaded.remove(created.id)).toBe(true);
    expect(loaded.active()).toBe(LOCAL_TARGET_ID);
    expect(loaded.activeArgs()).toEqual([]);
    expect(new TargetStore(file).list().targets).toEqual([]);
  });
});

test("target store repairs stale active id and rejects corrupt files", () => {
  const directory = mkdtempSync(join(tmpdir(), "shelt-targets-"));
  try {
    const file = join(directory, "herdr-targets.json");
    const store = new TargetStore(file);
    const created = store.create("dev", "example.com", null);
    store.activate(created.id);
    const corrupted = JSON.parse(readFileSync(file, "utf8"));
    corrupted.active = "ffffffff";
    const stale = join(directory, "stale.json");
    writeFileSync(stale, JSON.stringify(corrupted));
    expect(new TargetStore(stale).active()).toBe(LOCAL_TARGET_ID);
    const invalid = join(directory, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ active: "local", targets: [{ id: "zz", name: "x", remote: "-bad", session: null }] }));
    expect(() => new TargetStore(invalid)).toThrow("Invalid Herdr target records");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
