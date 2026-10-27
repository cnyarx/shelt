import { expect, test } from "bun:test";
import { previewSource, sameAgent, sourceFromUrl, terminalPreviewUrl } from "../src/preview-source.ts";

const source = { targetId: "local", paneId: "workspace:pane", session: "a".repeat(64) };
test("preview source retains exact identity and validates untrusted URL input", () => {
  const url = new URL("http://localhost/preview?path=/document.md");
  url.searchParams.set("source", JSON.stringify(source));
  expect(sourceFromUrl(url)).toEqual(source);
  expect(sameAgent(source, { ...source })).toBe(true);
  expect(sameAgent(source, { ...source, targetId: "abcd1234" })).toBe(false);
  expect(sameAgent(source, { ...source, session: "b".repeat(64) })).toBe(false);
  for (const invalid of [null, {}, { ...source, session: "bad" }, { ...source, paneId: "unsafe;command" }, { ...source, targetId: "user@arbitrary-host" }]) expect(previewSource(invalid)).toBeNull();
  expect(sourceFromUrl(new URL("http://localhost/preview?source=bad"))).toBeNull();
  expect(sourceFromUrl(new URL("http://localhost/preview?path=/document.md"))).toBeNull();
});
test("only same-origin preview links use the click-time source capture endpoint", () => {
  const origin = "http://localhost:8790";
  expect(terminalPreviewUrl("/preview?path=%2Fmy%20doc.md#section", origin)).toBe("/api/preview-edits/open?path=%2Fmy%20doc.md#section");
  expect(terminalPreviewUrl("/api/resolve-terminal-path?path=docs%2Freadme.md", origin)).toBe("/api/preview-edits/open?path=docs%2Freadme.md");
  for (const value of ["https://example.com/preview?path=/x.md", "/share/abcd", "/api/preview?path=/x.md", "/preview"]) expect(terminalPreviewUrl(value, origin)).toBeNull();
});
