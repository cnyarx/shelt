import { describe, expect, test } from "bun:test";
import { createSemanticAnsiState, normalizeSemanticAnsiChunk, resetSemanticAnsiState, stripTransientPaneScrollbars } from "../src/ansi.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("SemanticFrame ANSI normalization", () => {
  test("preserves pane scrollbar and border cells", () => {
    const frame = encoder.encode("\x1b[?2026h\x1b[3;102H\x1b[0;2;39;49m│\x1b[4;102H│\x1b[5;102H│\x1b[3;103H\x1b[0;38;2;30;102;245;49m│\x1b[3;104H\x1b[0;38;2;156;160;176;49m│\x1b[?2026l");
    expect(stripTransientPaneScrollbars(frame)).toEqual(frame);
  });

  test("preserves dim text, sidebar bars, colored borders, and OSC 52", () => {
    const frame = encoder.encode("\x1b[?2026h\x1b[2m中文\x1b[4;10H│\x1b[4;103H\x1b[0;34m│\x1b]52;c;5Lit5paH\x07\x1b[?2026l");
    expect(decoder.decode(stripTransientPaneScrollbars(frame))).toBe(decoder.decode(frame));
  });

  test("does not interpret RGB color mode as dim", () => {
    const frame = encoder.encode("\x1b[?2026h\x1b[3;102H\x1b[0;38;2;156;160;176;49m│\x1b[4;102H│\x1b[5;102H│\x1b[?2026l");
    expect(decoder.decode(stripTransientPaneScrollbars(frame))).toBe(decoder.decode(frame));
  });

  test("preserves Unicode text without reimplementing terminal cell widths", () => {
    const state = createSemanticAnsiState();
    const frame = encoder.encode(
      "\x1b[?2026h" +
      "\x1b[15;93H\x1b[0;39;49m working 时👨‍👩‍👧‍👦é" +
      "\x1b[3;103H\x1b[0;38;2;156;160;176;49m│" +
      "\x1b]52;c;5Lit5paH\x07" +
      "\x1b[?2026l",
    );

    expect(concat(normalizeSemanticAnsiChunk(state, frame))).toEqual(frame);
  });

  test("drops pending bytes and learned border columns before reconnecting at a new geometry", () => {
    const state = createSemanticAnsiState();
    normalizeSemanticAnsiChunk(state, encoder.encode("\x1b[?2026"));

    resetSemanticAnsiState(state);

    expect(state.pending.length).toBe(0);
    const update = encoder.encode("\x1b[?2026h\x1b[15;102H时\x1b[?2026l");
    expect(concat(normalizeSemanticAnsiChunk(state, update))).toEqual(update);
  });

  test("assembles a synchronized frame split across websocket chunks", () => {
    const state = createSemanticAnsiState();
    const input = encoder.encode("prefix\x1b[?2026h\x1b[8;102H\x1b[0;2;39;49m│\x1b[9;102H│\x1b[10;102H│\x1b[8;103H\x1b[0;34m│\x1b[?2026lsuffix");
    const output = [
      ...normalizeSemanticAnsiChunk(state, input.slice(0, 12)),
      ...normalizeSemanticAnsiChunk(state, input.slice(12, 41)),
      ...normalizeSemanticAnsiChunk(state, input.slice(41)),
    ];
    expect(concat(output)).toEqual(input);
    expect(state.pending.length).toBe(0);
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
