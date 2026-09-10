import { describe, expect, test } from "bun:test";
import { normalizeVisibleViewport } from "../src/mobile-viewport.ts";

describe("mobile visual viewport", () => {
  test("rounds the visible area reported while the keyboard is open", () => {
    expect(normalizeVisibleViewport(421.6, 17.4)).toEqual({ height: 422, offsetTop: 17 });
  });

  test("keeps viewport dimensions valid at browser transition boundaries", () => {
    expect(normalizeVisibleViewport(0, -4)).toEqual({ height: 1, offsetTop: 0 });
  });
});
