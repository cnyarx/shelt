export const TOUCH_WHEEL_THRESHOLD = 28;

export function consumeTouchWheelDelta(accumulated: number, deltaY: number, threshold = TOUCH_WHEEL_THRESHOLD): { ticks: number; remainder: number } {
  const total = accumulated + deltaY;
  const ticks = Math.trunc(total / threshold);
  return { ticks, remainder: total - ticks * threshold };
}

export function updateTouchGestureState(blockedUntilEnd: boolean, touchCount: number): { blockedUntilEnd: boolean; singleTouchActive: boolean } {
  if (touchCount === 0) return { blockedUntilEnd: false, singleTouchActive: false };
  if (blockedUntilEnd || touchCount !== 1) return { blockedUntilEnd: true, singleTouchActive: false };
  return { blockedUntilEnd: false, singleTouchActive: true };
}

export function installTerminalTouchScrolling(mount: HTMLElement): void {
  let lastX = 0;
  let lastY = 0;
  let accumulated = 0;
  let blockedUntilEnd = false;
  let singleTouchActive = false;

  mount.addEventListener("touchstart", (event) => {
    const state = updateTouchGestureState(blockedUntilEnd, event.touches.length);
    blockedUntilEnd = state.blockedUntilEnd;
    singleTouchActive = state.singleTouchActive;
    accumulated = 0;
    if (!singleTouchActive) return;
    lastX = event.touches[0]!.clientX;
    lastY = event.touches[0]!.clientY;
  }, { passive: true });

  mount.addEventListener("touchmove", (event) => {
    const state = updateTouchGestureState(blockedUntilEnd, event.touches.length);
    blockedUntilEnd = state.blockedUntilEnd;
    singleTouchActive = state.singleTouchActive;
    if (!singleTouchActive) { accumulated = 0; return; }
    const touch = event.touches[0]!;
    const deltaX = touch.clientX - lastX;
    const deltaY = lastY - touch.clientY;
    lastX = touch.clientX;
    lastY = touch.clientY;
    if (Math.abs(deltaY) <= Math.abs(deltaX)) return;

    const result = consumeTouchWheelDelta(accumulated, deltaY);
    accumulated = result.remainder;
    if (result.ticks === 0) return;

    event.preventDefault();
    const terminalElement = mount.querySelector<HTMLElement>(".xterm");
    if (!terminalElement) return;
    const direction = Math.sign(result.ticks);
    for (let index = 0; index < Math.abs(result.ticks); index++) {
      terminalElement.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: direction,
      }));
    }
  }, { passive: false });

  const finishTouch = (event: TouchEvent) => {
    const state = updateTouchGestureState(blockedUntilEnd, event.touches.length);
    blockedUntilEnd = state.blockedUntilEnd;
    singleTouchActive = false;
    accumulated = 0;
  };
  mount.addEventListener("touchend", finishTouch, { passive: true });
  mount.addEventListener("touchcancel", finishTouch, { passive: true });
}
