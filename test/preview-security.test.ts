import { describe, expect, test } from "bun:test";
import {
  MAX_DOCUMENT_BYTES,
  MAX_MARKDOWN_BYTES,
  MAX_PREVIEW_IMAGE_BYTES,
  previewRoots,
  previewType,
  wikiLinkCandidates,
  withinPreviewRoot,
} from "../src/preview-security.ts";

describe("preview security", () => {
  test("uses configured roots or falls back to home", () => {
    expect(previewRoots("/srv/docs:/home/user/work:/srv/docs", "/home/user")).toEqual([
      "/srv/docs",
      "/home/user/work",
    ]);
    expect(previewRoots(undefined, "/home/user")).toEqual(["/home/user"]);
    expect(previewRoots("", undefined)).toEqual([]);
  });

  test("maps only supported extensions to bounded content types", () => {
    expect(previewType("/tmp/README.MD")).toEqual({
      kind: "markdown",
      contentType: "text/markdown; charset=utf-8",
      maxBytes: MAX_MARKDOWN_BYTES,
    });
    expect(previewType("/tmp/page.htm")?.maxBytes).toBe(MAX_DOCUMENT_BYTES);
    expect(previewType("/tmp/diagram.svg")?.kind).toBe("svg");
    expect(previewType("/tmp/photo.jpeg")).toEqual({
      kind: "image",
      contentType: "image/jpeg",
      maxBytes: MAX_PREVIEW_IMAGE_BYTES,
    });
    expect(previewType("/tmp/report.pdf")).toBeNull();
    expect(previewType("/tmp/script.js")).toBeNull();
  });

  test("matches complete canonical path components", () => {
    expect(withinPreviewRoot("/home/user/docs/readme.md", ["/home/user"])).toBe(true);
    expect(withinPreviewRoot("/home/user", ["/home/user"])).toBe(true);
    expect(withinPreviewRoot("/home/user-other/readme.md", ["/home/user"])).toBe(false);
    expect(withinPreviewRoot("/etc/passwd", ["/home/user", "/srv/docs"])).toBe(false);
  });

  test("builds bounded wiki link candidates from the source directory to the preview root", () => {
    expect(wikiLinkCandidates(
      "/home/admin/github/cnyarx/xian/计算机学/长上下文.md",
      "物理学/弦理论",
      ["/home/admin/github/cnyarx/xian"],
    )).toEqual([
      "/home/admin/github/cnyarx/xian/计算机学/物理学/弦理论.md",
      "/home/admin/github/cnyarx/xian/计算机学/物理学/弦理论.markdown",
      "/home/admin/github/cnyarx/xian/物理学/弦理论.md",
      "/home/admin/github/cnyarx/xian/物理学/弦理论.markdown",
    ]);
    expect(wikiLinkCandidates("/home/user/docs/readme.md", "../secret", ["/home/user"])).toEqual([]);
    expect(wikiLinkCandidates("/home/user/docs/readme.md", "/etc/passwd", ["/home/user"])).toEqual([]);
  });
});
