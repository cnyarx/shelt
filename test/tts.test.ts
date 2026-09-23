import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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

test("read-aloud language updates without resetting playback, highlighting or voice selection", () => {
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8").replaceAll("export ", "") + "\n" +
    readFileSync(new URL("../src/tts.ts", import.meta.url), "utf8").replace(/^import .*\n/gm, "").replaceAll("export ", ""),
  );
  const elements = new Map<string, any>();
  for (const id of ["tts-toolbar", "tts-toggle", "tts-start", "tts-target", "tts-pause", "tts-stop", "tts-voice", "tts-rate", "tts-status"]) {
    elements.set(id, { textContent: "", value: "", disabled: false, attributes: {} as Record<string, string>, addEventListener() {}, setAttribute(name: string, value: string) { this.attributes[name] = value; }, classList: { contains: () => true, toggle() {} } });
  }
  const context: any = {
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: (id: string) => elements.get(id), addEventListener() {} },
  };
  runInNewContext(`${source}\nglobalThis.reader = new PreviewTtsController();`, context);
  const reader = context.reader;
  let pauses = 0;
  const audio = { pause: () => { pauses += 1; } };
  const highlighted = {};
  reader.audio = audio;
  reader.highlighted = highlighted;
  reader.queueToken = 42;
  reader.blocks = [{ text: "文档内容", element: highlighted }];
  reader.setState("speaking", "speaking");
  context.setLanguage("en");
  expect(elements.get("tts-status").textContent).toBe("Reading with online neural voice");
  expect(elements.get("tts-pause").textContent).toBe("Pause");
  expect(reader.audio).toBe(audio);
  expect(reader.highlighted).toBe(highlighted);
  expect(reader.queueToken).toBe(42);
  expect(elements.get("tts-voice").value).toBe("zh-CN-XiaoxiaoNeural");
  reader.setState("paused", "paused");
  context.setLanguage("zh-CN");
  expect(elements.get("tts-pause").textContent).toBe("继续");
  expect(elements.get("tts-status").textContent).toBe("已暂停");
  expect(reader.state).toBe("paused");
  expect(pauses).toBe(0);
});
