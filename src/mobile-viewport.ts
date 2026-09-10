export type VisibleViewport = { height: number; offsetTop: number };

export function normalizeVisibleViewport(height: number, offsetTop: number): VisibleViewport {
  return {
    height: Math.max(1, Math.round(height)),
    offsetTop: Math.max(0, Math.round(offsetTop)),
  };
}

export function installVisibleViewportSizing(onResize: () => void): void {
  let frame: number | undefined;
  const update = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const viewport = window.visualViewport;
      const visible = normalizeVisibleViewport(viewport?.height ?? window.innerHeight, viewport?.offsetTop ?? 0);
      document.documentElement.style.setProperty("--shelt-viewport-height", `${visible.height}px`);
      document.documentElement.style.setProperty("--shelt-viewport-top", `${visible.offsetTop}px`);
      onResize();
    });
  };
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  update();
}
