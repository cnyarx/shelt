import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShareStore, imageSources } from "../src/shares.ts";
import { renderMarkdown } from "../src/markdown.ts";

test("share lifecycle, private hash persistence, rotation, expiry and revocation", () => {
  const directory = mkdtempSync(join(tmpdir(), "shelt-shares-"));
  try {
    const file = join(directory, "shares.json");
    const store = new ShareStore(file);
    const first = store.create("/doc.md").url.slice(7);
    expect(store.resolve(first)?.path).toBe("/doc.md");
    expect(readFileSync(file, "utf8")).not.toContain(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loaded = new ShareStore(file);
    expect(loaded.resolve(first)).toBeDefined();
    const second = loaded.create("/doc.md").url.slice(7);
    expect(loaded.resolve(first)).toBeUndefined();
    expect(loaded.resolve(second)).toBeDefined();
    loaded.revoke("/doc.md");
    expect(new ShareStore(file).resolve(second)).toBeUndefined();
    const third = loaded.create("/doc.md").url.slice(7);
    const entries = JSON.parse(readFileSync(file, "utf8"));
    entries[0].expiresAt = 1;
    writeFileSync(file, JSON.stringify(entries));
    expect(new ShareStore(file).resolve(third)).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("share renderer uses only scoped image URLs and no wiki resolver", () => {
  const key = "a".repeat(64);
  const source = '# Title\n![pic](images/a.png)\n[[Other]]';
  const rendered = renderMarkdown(source, `share:${key}`);
  expect(rendered.html).toContain(`/api/share/${key}?source=images%2Fa.png`);
  expect(rendered.html).not.toContain("/api/preview");
  expect(rendered.html).not.toContain("/api/resolve-wikilink");
  expect(imageSources(source)).toEqual(["images/a.png"]);
});
