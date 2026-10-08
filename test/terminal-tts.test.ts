import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { TerminalSpeechPlayer } from "../src/terminal-tts.ts";

const originalFetch = globalThis.fetch;
const originalAudio = globalThis.Audio;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  plays = 0;
  pauses = 0;
  constructor(public src: string) { super(); FakeAudio.instances.push(this); }
  async play() { this.plays++; }
  pause() { this.pauses++; }
  end() { this.dispatchEvent(new Event("ended")); }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.Audio = originalAudio;
  FakeAudio.instances = [];
});

function player() {
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
  const events: string[] = [];
  const instance = new TerminalSpeechPlayer(() => ({ voice: "zh-CN-XiaoxiaoNeural", rate: 1 }), (state) => events.push(state), () => events.push("failed"));
  return { instance, events };
}

describe("terminal speech playback", () => {
  test("plays chunks in order, prefetches one and does not replay completed text", async () => {
    const texts: string[] = [];
    globalThis.fetch = (async (_url, options) => {
      texts.push(JSON.parse(options!.body as string).text);
      return new Response(new Blob(["audio"]));
    }) as typeof fetch;
    const { instance } = player();
    const starts: number[] = [];
    instance.enqueue("first", () => starts.push(1));
    instance.enqueue("second", () => starts.push(2));
    await tick();
    expect(texts).toEqual(["first", "second"]);
    expect(starts).toEqual([1]);
    FakeAudio.instances[0]!.end();
    await tick();
    expect(starts).toEqual([1, 2]);
    FakeAudio.instances[1]!.end();
    await tick();
    expect(instance.busy).toBe(false);
    expect(FakeAudio.instances).toHaveLength(2);
    instance.stop();
  });

  test("pause during synthesis waits before playing", async () => {
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as unknown as typeof fetch;
    const { instance } = player();
    instance.enqueue("delayed", () => {});
    instance.togglePause();
    resolveFetch(new Response(new Blob(["audio"])));
    await tick();
    expect(FakeAudio.instances).toHaveLength(0);
    instance.togglePause();
    await tick();
    expect(FakeAudio.instances[0]!.plays).toBe(1);
    instance.stop();
  });

  test("stop cancels playback and stale synthesis cannot speak after restart", async () => {
    const pending: ((response: Response) => void)[] = [];
    globalThis.fetch = (() => new Promise<Response>((resolve) => pending.push(resolve))) as unknown as typeof fetch;
    const { instance } = player();
    const starts: string[] = [];
    instance.enqueue("old", () => starts.push("old"));
    instance.stop();
    instance.enqueue("new", () => starts.push("new"));
    pending[0]!(new Response(new Blob(["old"])));
    pending[1]!(new Response(new Blob(["new"])));
    await tick();
    expect(starts).toEqual(["new"]);
    expect(FakeAudio.instances).toHaveLength(1);
    instance.stop();
    expect(FakeAudio.instances[0]!.pauses).toBe(1);
  });

  test("a rejected resume of old audio cannot cancel a new playback session", async () => {
    globalThis.fetch = (async () => new Response(new Blob(["audio"]))) as unknown as typeof fetch;
    const { instance, events } = player();
    instance.enqueue("old", () => {});
    await tick();
    instance.togglePause();
    let rejectPlay!: (error: Error) => void;
    FakeAudio.instances[0]!.play = () => new Promise<void>((_resolve, reject) => { rejectPlay = reject; });
    instance.togglePause();
    instance.stop();
    instance.enqueue("new", () => {});
    rejectPlay(new Error("Old audio interrupted"));
    await tick();
    expect(events).not.toContain("failed");
    expect(FakeAudio.instances).toHaveLength(2);
    expect(instance.busy).toBe(true);
    instance.stop();
  });

  test("reports synthesis failure without continuing the queue", async () => {
    globalThis.fetch = (async () => new Response("unavailable", { status: 502 })) as unknown as typeof fetch;
    const { instance, events } = player();
    instance.enqueue("first", () => {});
    instance.enqueue("second", () => {});
    await tick();
    expect(events).toContain("failed");
    expect(instance.busy).toBe(false);
    expect(FakeAudio.instances).toHaveLength(0);
  });
});

function controllerFixture() {
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(new URL("../src/terminal-tts.ts", import.meta.url), "utf8").replace(/^import .*\n/gm, "").replaceAll("export ", "") +
    "\nglobalThis.createController = (terminal, mount) => new TerminalTtsController(terminal, mount);",
  );
  const listeners = new Map<string, (event: any) => void>();
  const elements = new Map<string, any>();
  const makeElement = () => ({
    value: "", textContent: "", disabled: false, hidden: false, style: {}, options: [{ value: "1" }, { value: "zh-CN-XiaoxiaoNeural" }],
    classList: { toggle() { return true; } }, setAttribute() {}, addEventListener() {}, append() {},
  });
  for (const id of ["toolbar", "toggle", "target", "auto", "pause", "stop", "voice", "rate", "status"]) elements.set(`terminal-tts-${id}`, makeElement());
  const context: any = {
    AbortController, Date, URL, Audio: FakeAudio, setTimeout: () => 1, clearTimeout() {},
    document: { getElementById: (id: string) => elements.get(id), createElement: makeElement },
    localStorage: { getItem() { throw new Error("Storage blocked"); }, setItem() { throw new Error("Storage blocked"); } },
    onLanguageChange() {}, t: (key: string) => key,
    SpeechTranscript: class {}, readSpeechGrid: () => ({}), speechView: () => context.currentView,
    readySpeechText: () => ({ chunks: [], end: 0 }),
  };
  runInNewContext(source, context);
  const terminal = { onWriteParsed() {}, onResize() {}, cols: 100, rows: 40 };
  const mount = { querySelector: makeElement, classList: { toggle() {} }, addEventListener: (name: string, callback: (event: any) => void) => listeners.set(name, callback) };
  const controller = context.createController(terminal, mount);
  return { controller, context, listeners, elements };
}

describe("terminal read-aloud controller regressions", () => {
  test("storage rejection does not stop terminal initialization", () => {
    const { elements } = controllerFixture();
    expect(elements.get("terminal-tts-voice").value).toBe("zh-CN-XiaoxiaoNeural");
    expect(elements.get("terminal-tts-rate").value).toBe("1");
  });

  test("modifier and arrow keys do not suspend automatic speech", () => {
    const { controller, listeners } = controllerFixture();
    controller.mode = "auto";
    for (const key of ["Shift", "ArrowLeft", "ArrowRight", "AltGraph"]) listeners.get("keydown")!({ key });
    expect(controller.autoInput).toBe(false);
    listeners.get("keydown")!({ key: "a" });
    expect(controller.autoInput).toBe(true);
    listeners.get("keydown")!({ key: "Enter" });
    expect(controller.autoInput).toBe(false);
  });

  test("paused playback still tracks incoming frames without scrolling or speaking", () => {
    const { controller, context } = controllerFixture();
    let updates = 0;
    context.currentView = { rows: [], region: {} };
    controller.mode = "auto";
    controller.player.paused = true;
    controller.transcript = { update() { updates++; return true; } };
    controller.refresh();
    expect(updates).toBe(1);
    expect(controller.player.busy).toBe(false);
  });

  test("a tool boundary below a selected continuation does not prevent upward search", () => {
    const { controller, context } = controllerFixture();
    context.currentView = { rows: [{ row: 2, kind: "body", text: "continued reply" }, { row: 5, kind: "boundary", text: "✓ Shell" }], region: {} };
    controller.mode = "read";
    controller.searching = true;
    controller.selected = 2;
    controller.transcript = { update: () => true, blockAt: () => undefined, indexAtRow: (row: number) => row };
    const directions: number[] = [];
    controller.scroll = (direction: number) => directions.push(direction);
    controller.refresh();
    expect(directions).toEqual([-1]);
    expect(controller.mode).toBe("read");
  });

  test("automatic speech never flushes an unfinished tail just because the screen is quiet", () => {
    const { controller, context } = controllerFixture();
    context.currentView = { rows: [], region: {} };
    controller.mode = "auto";
    controller.transcript = { update: () => true, changedAt: 0, blocks: () => [{ start: 0, end: 1, text: "unfinished tail", closed: false }] };
    const flushes: boolean[] = [];
    context.readySpeechText = (_text: string, _end: number, flush: boolean) => { flushes.push(flush); return { chunks: [], end: 0 }; };
    controller.refresh();
    expect(flushes).toEqual([false]);
  });
});
