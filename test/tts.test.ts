import { describe, expect, test } from "bun:test";
import { MAX_TTS_TEXT_CHARS, normalizeTtsText, splitTtsText } from "../src/tts.ts";

describe("preview TTS", () => {
  test("normalizes whitespace and ignores empty text", () => {
    expect(normalizeTtsText("  第一段\n\t第二行  ")).toBe("第一段 第二行");
    expect(splitTtsText(" \n\t ")).toEqual([]);
  });

  test("splits long text at sentence boundaries within the API limit", () => {
    const text = `${"第一句。".repeat(180)}${"第二句。".repeat(180)}`;
    const chunks = splitTtsText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= MAX_TTS_TEXT_CHARS)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  test("hard-splits unbroken content without dropping text", () => {
    const text = "A".repeat(MAX_TTS_TEXT_CHARS * 2 + 25);
    expect(splitTtsText(text)).toEqual([
      "A".repeat(MAX_TTS_TEXT_CHARS),
      "A".repeat(MAX_TTS_TEXT_CHARS),
      "A".repeat(25),
    ]);
  });

  test("counts Unicode characters without splitting emoji surrogate pairs", () => {
    const text = "😀".repeat(MAX_TTS_TEXT_CHARS + 1);
    const chunks = splitTtsText(text);
    expect(chunks.map((chunk) => [...chunk].length)).toEqual([MAX_TTS_TEXT_CHARS, 1]);
    expect(chunks.join("")).toBe(text);
  });
});
