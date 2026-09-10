export type SemanticAnsiState = {
  pending: Uint8Array;
};

export function createSemanticAnsiState(): SemanticAnsiState {
  return { pending: new Uint8Array() };
}

export function resetSemanticAnsiState(state: SemanticAnsiState): void {
  state.pending = new Uint8Array();
}

export function normalizeSemanticAnsiChunk(_state: SemanticAnsiState, chunk: Uint8Array): Uint8Array[] {
  return chunk.length > 0 ? [stripTransientPaneScrollbars(chunk)] : [];
}

export function stripTransientPaneScrollbars(frame: Uint8Array): Uint8Array {
  return frame;
}
