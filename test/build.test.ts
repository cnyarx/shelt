import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("production bundle", () => {
  test("loads the terminal styles, Sheltie favicon and authentication UI", async () => {
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html).toContain('href="/client.css"');
    expect(html).toContain('href="/style.css"');
    expect(html).toContain('sizes="16x16" href="/favicon-16.png"');
    expect(html).toContain('sizes="32x32" href="/favicon-32.png"');
    expect(html).toContain('sizes="64x64" href="/favicon-64.png"');
    expect(html).toContain('rel="apple-touch-icon" href="/favicon.png"');
    expect(html).toContain('id="auth-form"');
    expect(html).toContain('id="terminal"');
    expect(await Bun.file(join(root, "dist/client.css")).exists()).toBe(true);
    expect(await Bun.file(join(root, "dist/client.js")).exists()).toBe(true);
    expect(await Bun.file(join(root, "dist/favicon.png")).exists()).toBe(true);
    expect(await Bun.file(join(root, "dist/favicon-16.png")).exists()).toBe(true);
    expect(await Bun.file(join(root, "dist/favicon-32.png")).exists()).toBe(true);
    expect(await Bun.file(join(root, "dist/favicon-64.png")).exists()).toBe(true);
  });
});
