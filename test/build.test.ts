import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("production bundle", () => {
  test("loads both the xterm stylesheet and the Shelt shell stylesheet", async () => {
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html).toContain('href="/client.css"');
    expect(html).toContain('href="/style.css"');
    expect(await Bun.file(join(root, "dist/client.css")).exists()).toBe(true);
    expect(await Bun.file(join(root, "dist/client.js")).exists()).toBe(true);
  });
});
