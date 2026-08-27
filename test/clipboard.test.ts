import { describe, expect, test } from "bun:test";
import { decodeOsc52 } from "../src/clipboard.ts";

function osc52(selection: string, text: string): string {
  return `${selection};${Buffer.from(text, "utf8").toString("base64")}`;
}

describe("OSC 52 clipboard", () => {
  test("decodes ASCII and preserves the selection field", () => {
    expect(decodeOsc52(osc52("c", "copied text"))).toEqual({
      ok: true,
      selection: "c",
      text: "copied text",
    });
    expect(decodeOsc52(osc52("p", "primary"))).toEqual({
      ok: true,
      selection: "p",
      text: "primary",
    });
  });

  test("decodes UTF-8 Chinese text", () => {
    expect(decodeOsc52(osc52("c", "复制中文内容"))).toEqual({
      ok: true,
      selection: "c",
      text: "复制中文内容",
    });
  });

  test("accepts an empty clipboard payload", () => {
    expect(decodeOsc52("c;")).toEqual({ ok: true, selection: "c", text: "" });
  });

  test("rejects malformed base64 and invalid UTF-8", () => {
    expect(decodeOsc52("c;not base64")).toEqual({ ok: false, error: "invalid-base64" });
    expect(decodeOsc52("c;//4=")).toEqual({ ok: false, error: "invalid-utf8" });
    expect(decodeOsc52("missing-separator")).toEqual({ ok: false, error: "invalid-format" });
  });

  test("enforces the decoded size limit", () => {
    expect(decodeOsc52(osc52("c", "12345"), 4)).toEqual({ ok: false, error: "too-large" });
    expect(decodeOsc52(osc52("c", "1234"), 4)).toEqual({ ok: true, selection: "c", text: "1234" });
  });
});
