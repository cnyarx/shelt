import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../src/sheltie-peek.ts", import.meta.url), "utf8").replace("export function", "function"),
);

function setup(random = 0.5, reduced = false) {
  const toggle = Object.assign(new EventTarget(), { hidden: true });
  const panel = Object.assign(new EventTarget(), { hidden: true });
  const classes = new Set<string>();
  const peek = Object.assign(new EventTarget(), { classList: { add: (name: string) => classes.add(name), remove: (...names: string[]) => names.forEach(name => classes.delete(name)), contains: (name: string) => classes.has(name) } });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const media = Object.assign(new EventTarget(), { matches: reduced });
  const window = Object.assign(new EventTarget(), { matchMedia: () => media });
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const observed: { target: unknown; options: unknown }[] = [];
  let sequence = 0;
  let changed = () => {};
  runInNewContext(`${source}\ninstallSheltiePeek(toggle, panel, peek);`, {
    toggle, panel, peek, document, window,
    Math: { random: () => random },
    setTimeout: (callback: () => void, delay: number) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    MutationObserver: class {
      constructor(callback: () => void) { changed = callback; }
      observe(target: unknown, options: unknown) { observed.push({ target, options }); }
    },
  });
  return {
    toggle, panel, peek, document, window, media, timers, observed,
    peeking: () => classes.has("is-peeking"),
    changed: () => changed(),
    fire: () => {
      expect(timers.size).toBe(1);
      const [id, timer] = timers.entries().next().value!;
      timers.delete(id);
      timer.callback();
    },
  };
}

for (const random of [0, 0.5, 0.999999]) {
  test(`Sheltie waits 3–5 minutes and schedules only once after hiding (${random})`, () => {
    const ui = setup(random);
    expect(ui.timers.size).toBe(0);
    expect(ui.peeking()).toBe(false);
    expect(ui.observed).toEqual([
      { target: ui.toggle, options: { attributes: true, attributeFilter: ["hidden"] } },
      { target: ui.panel, options: { attributes: true, attributeFilter: ["hidden"] } },
    ]);
    ui.toggle.hidden = false;
    ui.changed();
    const delay = [...ui.timers.values()][0]!.delay;
    expect(delay).toBe(180_000 + random * 120_000);
    expect(delay).toBeGreaterThanOrEqual(180_000);
    expect(delay).toBeLessThan(300_000);
    expect(ui.peeking()).toBe(false);
    ui.fire();
    expect(ui.peeking()).toBe(true);
    expect(ui.timers.size).toBe(0);
    ui.peek.dispatchEvent(new Event("animationend"));
    expect(ui.peeking()).toBe(false);
    expect(ui.timers.size).toBe(1);
    ui.peek.dispatchEvent(new Event("animationend"));
    expect(ui.timers.size).toBe(1);
  });
}

for (const reason of ["panel", "auth", "background", "motion"] as const) {
  test(`Sheltie cancels active and pending animation for ${reason}, then waits a fresh interval`, () => {
    const ui = setup();
    ui.toggle.hidden = false;
    ui.changed();
    const block = (blocked: boolean) => {
      if (reason === "panel") { ui.panel.hidden = !blocked; ui.changed(); }
      if (reason === "auth") { ui.toggle.hidden = blocked; ui.changed(); }
      if (reason === "background") { ui.document.hidden = blocked; ui.document.dispatchEvent(new Event("visibilitychange")); }
      if (reason === "motion") { ui.media.matches = blocked; ui.media.dispatchEvent(new Event("change")); }
    };
    block(true);
    expect(ui.timers.size).toBe(0);
    expect(ui.peeking()).toBe(false);
    block(false);
    expect(ui.timers.size).toBe(1);
    expect(ui.peeking()).toBe(false);
    ui.fire();
    expect(ui.peeking()).toBe(true);
    block(true);
    expect(ui.peeking()).toBe(false);
    expect(ui.timers.size).toBe(0);
    block(false);
    expect(ui.timers.size).toBe(1);
    expect([...ui.timers.values()][0]!.delay).toBe(240_000);
  });
}

test("Sheltie peeks once when the settings button is hovered and re-arms afterwards", () => {
  const ui = setup();
  ui.toggle.hidden = false;
  ui.changed();
  expect(ui.timers.size).toBe(1);
  ui.toggle.dispatchEvent(new Event("pointerenter"));
  expect(ui.peeking()).toBe(true);
  expect(ui.timers.size).toBe(0);
  ui.toggle.dispatchEvent(new Event("pointerenter"));
  expect(ui.peeking()).toBe(true);
  expect(ui.timers.size).toBe(0);
  ui.peek.dispatchEvent(new Event("animationend"));
  expect(ui.peeking()).toBe(false);
  expect(ui.timers.size).toBe(1);
  ui.panel.hidden = false;
  ui.changed();
  ui.toggle.dispatchEvent(new Event("pointerenter"));
  expect(ui.peeking()).toBe(false);
  expect(ui.timers.size).toBe(0);
});

test("reduced motion suppresses automatic peeks but permits an animated hover", () => {
  const ui = setup(0.5, true);
  ui.toggle.hidden = false;
  ui.changed();
  expect(ui.timers.size).toBe(0);
  expect(ui.peeking()).toBe(false);
  ui.toggle.dispatchEvent(new Event("pointerenter"));
  expect(ui.peeking()).toBe(true);
  expect(ui.timers.size).toBe(0);
  ui.toggle.dispatchEvent(new Event("pointerenter"));
  expect(ui.peeking()).toBe(true);
  ui.peek.dispatchEvent(new Event("animationend"));
  expect(ui.peeking()).toBe(false);
  expect(ui.timers.size).toBe(0);
  ui.toggle.dispatchEvent(new Event("pointerenter"));
  expect(ui.peeking()).toBe(true);
  ui.panel.hidden = false;
  ui.changed();
  expect(ui.peeking()).toBe(false);
  ui.toggle.dispatchEvent(new Event("pointerenter"));
  expect(ui.peeking()).toBe(false);
  ui.panel.hidden = true;
  ui.changed();
  expect(ui.peeking()).toBe(false);
  ui.window.dispatchEvent(new Event("pagehide"));
  expect(ui.timers.size).toBe(0);
});

test("changing motion preference never starts an automatic peek in reduced mode", () => {
  const ui = setup(0.5, false);
  ui.toggle.hidden = false;
  ui.changed();
  expect(ui.timers.size).toBe(1);
  ui.media.matches = true;
  ui.media.dispatchEvent(new Event("change"));
  expect(ui.timers.size).toBe(0);
  ui.toggle.dispatchEvent(new Event("pointerenter"));
  expect(ui.peeking()).toBe(true);
  ui.media.matches = false;
  ui.media.dispatchEvent(new Event("change"));
  expect(ui.peeking()).toBe(false);
  expect(ui.timers.size).toBe(1);
});

test("Sheltie rechecks eligibility before a delayed timer fires", () => {
  const ui = setup();
  ui.toggle.hidden = false;
  ui.changed();
  ui.document.hidden = true;
  ui.fire();
  expect(ui.peeking()).toBe(false);
  expect(ui.timers.size).toBe(0);
  ui.document.hidden = false;
  ui.document.dispatchEvent(new Event("visibilitychange"));
  expect(ui.timers.size).toBe(1);
  expect(ui.peeking()).toBe(false);
});
