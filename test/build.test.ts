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
    const styles = await readFile(join(root, "dist/style.css"), "utf8");
    expect(styles).toContain(".document-link-indicators span { position: absolute; box-sizing: border-box; border-bottom: 2px solid #31bafd;");
    expect(styles).not.toContain("border-bottom: 2px solid transparent");
  });

  test("ships preview assets without loading Mermaid in the terminal bundle", async () => {
    const html = await readFile(join(root, "dist/preview.html"), "utf8");
    const styles = await readFile(join(root, "dist/preview.css"), "utf8");
    const client = await readFile(join(root, "dist/client.js"), "utf8");
    const preview = await readFile(join(root, "dist/preview.js"), "utf8");
    expect(html).toContain('id="preview"');
    expect(html).toContain('src="/preview.js"');
    expect(styles).toContain(".markdown-body { width: min(1600px, calc(100% - 48px));");
    expect(styles).toContain("overflow-wrap: break-word;");
    expect(styles).toContain(".table-wrap { max-width: 100%; overflow-x: auto; }");
    expect(styles).toContain("@media (max-width: 900px)");
    expect(styles).toContain(".markdown-body table { min-width: 900px; }");
    expect(styles).not.toContain("width: min(980px, calc(100% - 48px))");
    expect(preview.length).toBeGreaterThan(100_000);
    expect(client).not.toContain("Mermaid preview unavailable");
    expect(client).not.toContain('output:"mathml"');
    expect(preview).toContain("Mermaid preview unavailable");
    expect(preview).toContain('output:"mathml"');
  });
});
