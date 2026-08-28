import { describe, expect, test } from "bun:test";
import { allowedHost, allowedOrigin, bracketedPaste, hasImageSignature, imageExtension, safeUploadStem, uploadFileNameHeader } from "../src/security.ts";

describe("request security", () => {
  test("pins hosts and origins", () => {
    expect(allowedHost("127.0.0.1:8790", ["127.0.0.1:8790"])).toBe(true);
    expect(allowedHost("evil.example", ["127.0.0.1:8790"])).toBe(false);
    expect(allowedOrigin("http://127.0.0.1:8790", "127.0.0.1:8790", [])).toBe(true);
    expect(allowedOrigin("https://evil.example", "127.0.0.1:8790", [])).toBe(false);
  });
});

describe("image paste", () => {
  test("accepts only known image types", () => {
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("text/plain")).toBeNull();
  });

  test("checks image signatures instead of trusting MIME alone", () => {
    expect(hasImageSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png")).toBe(true);
    expect(hasImageSignature(new TextEncoder().encode("not an image"), "png")).toBe(false);
  });

  test("encodes non-ASCII upload headers before sanitizing names", () => {
    expect(uploadFileNameHeader("formal-中文.png")).toBe("formal-%E4%B8%AD%E6%96%87.png");
    expect(uploadFileNameHeader("../../my screenshot.png")).toBe("..%2F..%2Fmy%20screenshot.png");
    expect(safeUploadStem("../../my screenshot.png")).toBe("my-screenshot");
    expect(bracketedPaste("/tmp/image.png")).toBe("\x1b[200~/tmp/image.png\x1b[201~");
  });
});

describe("terminal links", () => {
  test("opens plain and OSC 8 links without the xterm confirmation dialog", async () => {
    const source = await Bun.file(new URL("../src/client.ts", import.meta.url)).text();
    expect(source).toContain('window.open(url, "_blank", "noopener,noreferrer")');
    expect(source).toContain("linkHandler: {");
    expect(source).toContain("activate: (_event, url) => openLink(url)");
    expect(source).toContain("new WebLinksAddon((_event, url) => openLink(url)");
  });
});

describe("terminal CSP", () => {
  test("allows xterm runtime styles without allowing inline scripts", async () => {
    const source = await Bun.file(new URL("../rust/main.rs", import.meta.url)).text();
    expect(source).toContain("style-src 'self' 'unsafe-inline'");
    expect(source).toContain("script-src 'self'");
    expect(source).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe("update-safe assets", () => {
  test("does not pin fixed-name client assets in browser cache", async () => {
    const source = await Bun.file(new URL("../rust/main.rs", import.meta.url)).text();
    expect(source).toContain('HeaderValue::from_static("no-cache")');
    expect(source).not.toContain("immutable");
  });
});
