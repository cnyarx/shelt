export function installSheltiePeek(toggle: HTMLElement, panel: HTMLElement, peek: HTMLElement): void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previousDirection = -1;
  const available = () => !toggle.hidden && panel.hidden && !document.hidden;
  const ready = () => available() && !reducedMotion.matches && !peek.classList.contains("is-peeking");
  const start = () => {
    let direction = Math.floor(Math.random() * (previousDirection < 0 ? 3 : 2));
    if (previousDirection >= 0 && direction >= previousDirection) direction += 1;
    previousDirection = direction;
    const angle = (direction * 30 + 5 + Math.random() * 25) * Math.PI / 180;
    const distance = 27 + Math.random() * 5;
    const tilt = -16 + Math.random() * 32;
    peek.style.setProperty("--peek-x", `${(-Math.cos(angle) * distance).toFixed(2)}px`);
    peek.style.setProperty("--peek-y", `${(Math.sin(angle) * distance).toFixed(2)}px`);
    peek.style.setProperty("--peek-tilt", `${tilt.toFixed(2)}deg`);
    peek.style.setProperty("--peek-look", `${(tilt + (Math.random() - 0.5) * 12).toFixed(2)}deg`);
    peek.classList.add("is-peeking");
  };

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
      if (ready()) start();
    }, 180_000 + Math.random() * 120_000);
  };
  const play = () => {
    if (!available() || peek.classList.contains("is-peeking")) return;
    clearTimeout(timer);
    timer = undefined;
    start();
  };

  peek.addEventListener("animationend", (event) => {
    if (event.target === peek) schedule();
  });
  toggle.addEventListener("pointerenter", play);
  document.addEventListener("visibilitychange", schedule);
  reducedMotion.addEventListener("change", schedule);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(toggle, { attributes: true, attributeFilter: ["hidden"] });
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  schedule();
}
