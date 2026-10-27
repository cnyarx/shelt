import { expect, test } from "bun:test";
import { setupPreviewTools } from "../src/preview-tools.ts";

test("opening a preview tool closes another panel without activating the wrong tool", () => {
  const ids = ["share-toggle", "tts-toggle", "toc-toggle", "edit-toggle"];
  const previous = globalThis.document;
  let listener: (event: any) => void;
  const buttons = new Map(ids.map(id => [id, {
    id, open: false, clicks: 0,
    getAttribute(name: string) { return name === (id === "edit-toggle" ? "aria-pressed" : "aria-expanded") ? String(this.open) : null; },
    click() { listener({ target: { closest: () => this } }); this.clicks++; this.open = !this.open; },
  }]));
  globalThis.document = { getElementById: (id: string) => id === "preview-tools" ? { addEventListener: (_: string, callback: typeof listener) => { listener = callback; } } : buttons.get(id) } as any;
  try {
    setupPreviewTools();
    for (const id of ids) {
      buttons.get(id)!.click();
      expect([...buttons.values()].filter(button => button.open).map(button => button.id)).toEqual([id]);
    }
    buttons.get("edit-toggle")!.click();
    expect([...buttons.values()].some(button => button.open)).toBe(false);
    expect(buttons.get("share-toggle")!.clicks).toBe(2);
  } finally { globalThis.document = previous; }
});
