export function installSheltiePeek(toggle: HTMLElement, panel: HTMLElement, peek: HTMLElement): void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hovered = false;
  let focused = false;
  const ready = () => !toggle.hidden && panel.hidden && !document.hidden && !reducedMotion.matches && !hovered && !focused;

  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    peek.classList.remove("is-peeking");
  };
  const schedule = () => {
    hide();
    if (!ready()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (ready()) peek.classList.add("is-peeking");
    }, 180_000 + Math.random() * 120_000);
  };

  peek.addEventListener("animationend", (event) => {
    if (event.target === peek) schedule();
  });
  toggle.addEventListener("pointerenter", () => { hovered = true; schedule(); });
  toggle.addEventListener("pointerleave", () => { hovered = false; schedule(); });
  toggle.addEventListener("focus", () => { focused = true; schedule(); });
  toggle.addEventListener("blur", () => { focused = false; schedule(); });
  document.addEventListener("visibilitychange", schedule);
  reducedMotion.addEventListener("change", schedule);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(toggle, { attributes: true, attributeFilter: ["hidden"] });
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  schedule();
}
