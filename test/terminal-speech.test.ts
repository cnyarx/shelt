import { describe, expect, test } from "bun:test";
import { alignSpeechRows, readySpeechText, speechView, SpeechTranscript, type SpeechGrid, type SpeechRow, type SpeechView } from "../src/terminal-speech.ts";

function grid(content: string[], sidebar = true): SpeechGrid {
  const left = sidebar ? 18 : 0;
  const width = 110;
  const height = Math.max(content.length + 6, 22);
  const lines = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  if (sidebar) {
    for (let y = 0; y < height; y++) {
      lines[y]![left - 1] = "│";
      [...(y === 4 ? "◆ sidebar fake" : "agent-list")].forEach((char, x) => { lines[y]![x] = char; });
    }
    [..."workspace build tab"].forEach((char, x) => { lines[0]![left + x] = char; });
  }
  for (let index = 0; index < content.length; index++) {
    [...content[index]!].forEach((char, x) => { lines[index + 1]![left + x] = char; });
  }
  for (const y of [height - 5, height - 3]) for (let x = left; x < width; x++) lines[y]![x] = "─";
  [..."* user input, never read"].forEach((char, x) => { lines[height - 4]![left + x] = char; });
  [..."YOLO mode (shift+tab to cycle)"].forEach((char, x) => { lines[height - 2]![left + x] = char; });
  return { lines, cursorX: left + 8, cursorY: height - 4 };
}

function view(rows: (string | [SpeechRow["kind"], string])[]): SpeechView {
  return {
    region: { left: 18, right: 100, top: 1, bottom: 20, marker: 20 }, context: "pane-one",
    rows: rows.map((value, index) => ({ row: index + 1, kind: typeof value === "string" ? "body" : value[0], text: typeof value === "string" ? value : value[1] })),
  };
}

describe("Qwen screen speech", () => {
  test("reads complete reply blocks, not only diamond lines, and excludes tool results", () => {
    const parsed = speechView(grid([
      "  ∴ Thought for 2m 7s",
      "  ◆ I will describe the repair, without applying it.",
      "  ✓ Shell date",
      "    2026-10-08 must not be spoken",
      "  ∴ Thought for 1m 8s",
      "  ◆ Keep existing deployment addresses.",
      "",
      "    1. Repair goals",
      "    - preserve shared paths",
      "      1 release64/deploy/",
      "      2 ├─ odps_tmp/",
      "",
      "    Shell is mentioned in prose, not a tool call.",
    ]));
    expect(parsed).not.toBeNull();
    const transcript = new SpeechTranscript();
    expect(transcript.update(parsed!)).toBe(true);
    const blocks = transcript.blocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.closed).toBe(true);
    expect(blocks[1]!.text).toContain("1. Repair goals - preserve shared paths");
    expect(blocks[1]!.text).toContain("release64/deploy/");
    expect(blocks[1]!.text).toContain("Shell is mentioned in prose");
    expect(blocks.map((block) => block.text).join(" ")).not.toMatch(/Thought|must not|sidebar|user input|agent-list/);
    expect(transcript.blockAt(blocks[1]!.start + 3)).toEqual(blocks[1]);
  });

  test("ignores the input, sidebar and plain shells without Qwen chrome", () => {
    const sample = grid(["  ◆ Hello reply", "    next line"]);
    expect(speechView(sample, { x: 5, y: 4 })).toBeNull();
    const parsed = speechView(sample)!;
    expect(parsed.rows.every((row) => row.row < parsed.region.bottom)).toBe(true);
    sample.lines[sample.lines.length - 2] = Array(110).fill(" ");
    expect(speechView(sample)).toBeNull();
  });

  test("supports a hidden Herdr sidebar and excludes compression diamonds", () => {
    const parsed = speechView(grid([
      "  ◆ Chat history compressed from 12000 to 3000 tokens.",
      "  ◆ Actual response.",
      "    A second line.",
    ], false))!;
    const transcript = new SpeechTranscript();
    expect(transcript.update(parsed)).toBe(true);
    expect(transcript.blocks().map((block) => block.text)).toEqual(["Actual response. A second line."]);
  });

  test("does not turn a list bullet into a message prefix after the diamond scrolls away", () => {
    const parsed = speechView(grid(["    1. Continued heading", "    - preserve shared paths", "    More continuation text."]))!;
    expect(parsed.region.marker).toBe(20);
    expect(parsed.rows.every((row) => row.kind === "body")).toBe(true);
    expect(parsed.rows[1]!.text).toBe("- preserve shared paths");
  });

  test("retains an observed zero-margin message column on continuation-only pages", () => {
    const first = speechView(grid(["◆ Actual reply without history margin.", "  Continuation text."]))!;
    expect(first.region.marker).toBe(18);
    const next = speechView(grid(["  Continuation text.", "    - Nested list stays in the reply."]), undefined, first.region)!;
    expect(next.region.marker).toBe(18);
    expect(next.rows.every((row) => row.kind === "body")).toBe(true);
  });

  test("rejects stacked Qwen panes rather than reading the upper pane as prose", () => {
    expect(speechView(grid(["  ◆ First pane.", "YOLO mode (shift+tab to cycle)", "  ◆ Second pane."]))).toBeNull();
  });

  test("streams a growing tail below a thought row without misaligning short text", () => {
    const transcript = new SpeechTranscript();
    expect(transcript.update(view([["boundary", "∴ Thought for 2s"], ["start", "short"]]))).toBe(true);
    expect(transcript.update(view([["boundary", "∴ Thought for 2s"], ["start", "short sentence completed."]]))).toBe(true);
    expect(transcript.blocks()[0]!.text).toBe("short sentence completed.");
  });

  test("joins overlapping pages without reading repeated paint as new text", () => {
    const first = view([["start", "Opening assistant paragraph."], "A sufficiently unique continuation.", "The next numbered point.", "Final visible row."]);
    const second = view(["The next numbered point.", "Final visible row.", "More text after scrolling.", ["boundary", "✓ Shell skipped"]]);
    const transcript = new SpeechTranscript();
    expect(transcript.update(first, 100)).toBe(true);
    expect(transcript.update(second, 200)).toBe(true);
    const block = transcript.blocks()[0]!;
    expect(block.start).toBe(0);
    expect(block.closed).toBe(true);
    expect(block.text).toBe("Opening assistant paragraph. A sufficiently unique continuation. The next numbered point. Final visible row. More text after scrolling.");
    expect(transcript.update(second, 300)).toBe(true);
    expect(transcript.changedAt).toBe(200);
    expect(transcript.blocks()).toEqual([block]);
  });

  test("finds the beginning above a selected continuation while keeping its logical index", () => {
    const transcript = new SpeechTranscript();
    expect(transcript.update(view(["Middle of a long assistant response.", "Still the same response with more details."]))).toBe(true);
    const selected = transcript.indexAtRow(2)!;
    expect(transcript.blockAt(selected)).toBeUndefined();
    expect(transcript.update(view([["start", "Beginning found above."], "Middle of a long assistant response.", "Still the same response with more details."]))).toBe(true);
    expect(transcript.blockAt(selected)?.text).toBe("Beginning found above. Middle of a long assistant response. Still the same response with more details.");
  });

  test("a taller input box preserves pane identity and clipped reply text", () => {
    const sample = grid(["  ◆ Original assistant reply, with enough content to align.", "    Continued response still belongs to the same reply."]);
    const first = speechView(sample)!;
    const expanded = { ...sample, lines: sample.lines.map((row) => [...row]) };
    const left = first.region.left;
    expanded.lines[first.region.bottom]!.fill(" ", left);
    expanded.lines[first.region.bottom - 1]!.fill("─", left);
    const next = speechView(expanded, undefined, first.region)!;
    expect(next.region.bottom).toBe(first.region.bottom - 1);
    expect(next.context).toBe(first.context);
    const transcript = new SpeechTranscript();
    expect(transcript.update(first)).toBe(true);
    expect(transcript.update(next)).toBe(true);
    expect(transcript.blocks()[0]!.text).toContain("Continued response");
  });

  test("rejects unrelated screens, changed pane identity and ambiguous overlap", () => {
    const transcript = new SpeechTranscript();
    const first = view([["start", "Original response with a unique start."]]);
    expect(transcript.update(first)).toBe(true);
    expect(transcript.update(view([["start", "Unrelated agent response."]]))).toBe(false);
    expect(transcript.update({ ...first, context: "pane-two" })).toBe(false);
    expect(alignSpeechRows(view(["a", "a"]).rows, view(["a"]).rows)).toBeNull();
  });

  test("tracks text growth and emits sentences once without waiting for the whole response", () => {
    const transcript = new SpeechTranscript();
    expect(transcript.update(view([["start", "第一句已完成。第二句"]]))).toBe(true);
    const first = readySpeechText(transcript.blocks()[0]!.text, 0);
    expect(first.chunks).toEqual(["第一句已完成。"]);
    expect(transcript.update(view([["start", "第一句已完成。第二句也完成了！第三句"]]))).toBe(true);
    const second = readySpeechText(transcript.blocks()[0]!.text, first.end);
    expect(second.chunks).toEqual(["第二句也完成了！"]);
    expect(readySpeechText(transcript.blocks()[0]!.text, second.end).chunks).toEqual([]);
    expect(readySpeechText(transcript.blocks()[0]!.text, second.end, true).chunks).toEqual(["第三句"]);
  });

  test("keeps text chunks within the synthesis limit and Unicode intact", () => {
    const text = `${"😀中文".repeat(450)}。`;
    const ready = readySpeechText(text, 0);
    expect(ready.chunks.join("")).toBe(text);
    expect(ready.chunks.every((chunk) => [...chunk].length <= 401)).toBe(true);
    expect(ready.end).toBe(text.length);
  });
});
