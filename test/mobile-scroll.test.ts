import { describe, expect, test } from "bun:test";
import {
  consumeTouchWheelDelta,
  consumeTouchWheelTicks,
  MAX_TOUCH_WHEEL_TICKS_PER_FRAME,
  TOUCH_WHEEL_THRESHOLD,
  updateTouchGestureState,
} from "../src/mobile-scroll.ts";

describe("mobile terminal scrolling", () => {
  test("accumulates small vertical movements until one wheel tick", () => {
    const first = consumeTouchWheelDelta(0, 10);
    expect(first).toEqual({ ticks: 0, remainder: 10 });
    expect(consumeTouchWheelDelta(first.remainder, 18)).toEqual({ ticks: 1, remainder: 0 });
  });

  test("preserves direction and remainder across multiple ticks", () => {
    expect(consumeTouchWheelDelta(0, TOUCH_WHEEL_THRESHOLD * 2 + 7)).toEqual({ ticks: 2, remainder: 7 });
    expect(consumeTouchWheelDelta(0, -(TOUCH_WHEEL_THRESHOLD * 2 + 7))).toEqual({ ticks: -2, remainder: -7 });
  });

  test("cancels opposite movements before emitting a tick", () => {
    const first = consumeTouchWheelDelta(0, 20);
    expect(consumeTouchWheelDelta(first.remainder, -12)).toEqual({ ticks: 0, remainder: 8 });
  });

  test("limits a large movement to a bounded number of wheel reports per frame", () => {
    expect(consumeTouchWheelTicks(17)).toEqual({
      ticks: MAX_TOUCH_WHEEL_TICKS_PER_FRAME,
      remainder: 17 - MAX_TOUCH_WHEEL_TICKS_PER_FRAME,
    });
    expect(consumeTouchWheelTicks(-17)).toEqual({
      ticks: -MAX_TOUCH_WHEEL_TICKS_PER_FRAME,
      remainder: -(17 - MAX_TOUCH_WHEEL_TICKS_PER_FRAME),
    });
    expect(consumeTouchWheelTicks(3)).toEqual({ ticks: 3, remainder: 0 });
  });

  test("reserves multi-touch gestures for browser pinch zoom until every finger is lifted", () => {
    expect(updateTouchGestureState(false, 1)).toEqual({ blockedUntilEnd: false, singleTouchActive: true });
    expect(updateTouchGestureState(false, 2)).toEqual({ blockedUntilEnd: true, singleTouchActive: false });
    expect(updateTouchGestureState(true, 1)).toEqual({ blockedUntilEnd: true, singleTouchActive: false });
    expect(updateTouchGestureState(true, 0)).toEqual({ blockedUntilEnd: false, singleTouchActive: false });
    expect(updateTouchGestureState(false, 1)).toEqual({ blockedUntilEnd: false, singleTouchActive: true });
  });
});
