const SYNC_START = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]);
const SYNC_END = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]);

export type SemanticAnsiState = {
  pending: Uint8Array;
};

export function createSemanticAnsiState(): SemanticAnsiState {
  return { pending: new Uint8Array() };
}

export function resetSemanticAnsiState(state: SemanticAnsiState): void {
  state.pending = new Uint8Array();
}

export function normalizeSemanticAnsiChunk(state: SemanticAnsiState, chunk: Uint8Array): Uint8Array[] {
  state.pending = concat(state.pending, chunk);
  const output: Uint8Array[] = [];

  while (state.pending.length > 0) {
    const start = indexOf(state.pending, SYNC_START);
    if (start < 0) {
      const retained = longestSuffixPrefix(state.pending, SYNC_START);
      const emitLength = state.pending.length - retained;
      if (emitLength > 0) output.push(state.pending.slice(0, emitLength));
      state.pending = state.pending.slice(emitLength);
      break;
    }
    if (start > 0) {
      output.push(state.pending.slice(0, start));
      state.pending = state.pending.slice(start);
    }

    const end = indexOf(state.pending, SYNC_END, SYNC_START.length);
    if (end < 0) break;
    const frameEnd = end + SYNC_END.length;
    output.push(normalizeSemanticFrame(state, state.pending.slice(0, frameEnd)));
    state.pending = state.pending.slice(frameEnd);
  }

  return output;
}

function normalizeSemanticFrame(_state: SemanticAnsiState, frame: Uint8Array): Uint8Array {
  return stripTransientPaneScrollbars(frame);
}

export function stripTransientPaneScrollbars(frame: Uint8Array): Uint8Array {
  return frame;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  for (let index = start; index <= haystack.length - needle.length; index += 1) {
    if (matchesAt(haystack, needle, index)) return index;
  }
  return -1;
}

function matchesAt(haystack: Uint8Array, needle: Uint8Array, index: number): boolean {
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (haystack[index + offset] !== needle[offset]) return false;
  }
  return true;
}

function longestSuffixPrefix(bytes: Uint8Array, prefix: Uint8Array): number {
  for (let length = Math.min(bytes.length, prefix.length - 1); length > 0; length -= 1) {
    if (matchesAt(bytes, prefix.slice(0, length), bytes.length - length)) return length;
  }
  return 0;
}
