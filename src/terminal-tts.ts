import type { Terminal } from "@xterm/xterm";
import { onLanguageChange, t, type MessageKey } from "./i18n.ts";
import { readSpeechGrid, readySpeechText, speechView, SpeechTranscript, type SpeechRegion, type SpeechView } from "./terminal-speech.ts";

type AudioChunk = { text: string; start: () => void };
type PlayerState = "idle" | "loading" | "speaking" | "paused";

export class TerminalSpeechPlayer {
  private chunks: AudioChunk[] = [];
  private abort = new AbortController();
  private audio: HTMLAudioElement | undefined;
  private cancelPlayback: (() => void) | undefined;
  private resumeWait: (() => void) | undefined;
  private running = false;
  paused = false;

  constructor(
    private readonly preferences: () => { voice: string; rate: number },
    private readonly state: (state: PlayerState) => void,
    private readonly failed: () => void,
  ) {}

  get busy(): boolean { return this.running || this.chunks.length > 0; }

  enqueue(text: string, start: () => void): void {
    this.chunks.push({ text, start });
    if (!this.running) void this.drain();
  }

  togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) {
      this.audio?.pause();
      this.state("paused");
    } else {
      this.resumeWait?.();
      this.resumeWait = undefined;
      const signal = this.abort.signal;
      if (this.audio) void this.audio.play().catch(() => { if (!signal.aborted) this.failed(); });
      this.state(this.running ? "speaking" : "idle");
    }
  }

  stop(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.chunks = [];
    this.audio?.pause();
    this.cancelPlayback?.();
    this.cancelPlayback = undefined;
    this.resumeWait?.();
    this.resumeWait = undefined;
    this.audio = undefined;
    this.running = false;
    this.paused = false;
    this.state("idle");
  }

  private async fetchAudio(chunk: AudioChunk, signal: AbortSignal): Promise<Blob | null> {
    try {
      const response = await fetch("/api/tts", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk.text, ...this.preferences() }), signal,
      });
      return response.ok ? await response.blob() : null;
    } catch { return null; }
  }

  private async drain(): Promise<void> {
    this.running = true;
    const signal = this.abort.signal;
    let pending: Promise<Blob | null> | undefined;
    try {
      while (this.chunks.length && !signal.aborted) {
        const chunk = this.chunks[0]!;
        if (!this.paused) this.state("loading");
        const blob = await (pending ?? this.fetchAudio(chunk, signal));
        if (signal.aborted) return;
        if (!blob) throw new Error("TTS unavailable");
        this.chunks.shift();
        pending = this.chunks[0] ? this.fetchAudio(this.chunks[0], signal) : undefined;
        if (this.paused) await new Promise<void>((resolve) => { this.resumeWait = resolve; });
        if (signal.aborted) return;
        const url = URL.createObjectURL(blob);
        try {
          chunk.start();
          this.state("speaking");
          await new Promise<void>((resolve, reject) => {
            const audio = new Audio(url);
            this.audio = audio;
            this.cancelPlayback = resolve;
            audio.addEventListener("ended", () => resolve(), { once: true });
            audio.addEventListener("error", () => reject(new Error("Audio failed")), { once: true });
            void audio.play().catch(reject);
          });
        } finally { URL.revokeObjectURL(url); }
        if (!signal.aborted) { this.audio = undefined; this.cancelPlayback = undefined; }
      }
    } catch {
      if (!signal.aborted) { this.stop(); this.failed(); }
    } finally {
      if (!signal.aborted) { this.running = false; this.state("idle"); }
    }
  }
}

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(`terminal-tts-${id}`);
  if (!result) throw new Error(`Terminal TTS UI missing: ${id}`);
  return result as T;
}

export class TerminalTtsController {
  private readonly toolbar = element<HTMLElement>("toolbar");
  private readonly toggle = element<HTMLButtonElement>("toggle");
  private readonly target = element<HTMLButtonElement>("target");
  private readonly auto = element<HTMLButtonElement>("auto");
  private readonly pause = element<HTMLButtonElement>("pause");
  private readonly stopButton = element<HTMLButtonElement>("stop");
  private readonly voice = element<HTMLSelectElement>("voice");
  private readonly rate = element<HTMLSelectElement>("rate");
  private readonly status = element<HTMLElement>("status");
  private readonly highlight: HTMLDivElement;
  private readonly player: TerminalSpeechPlayer;
  private transcript = new SpeechTranscript();
  private consumed = new Map<number, { text: string; end: number }>();
  private mode: "off" | "target" | "read" | "auto" = "off";
  private anchor: { x: number; y: number } | undefined;
  private selected = 0;
  private searching = false;
  private scrollAttempts = 0;
  private unchangedScrolls = 0;
  private lastScrollSignature = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ownWheel = false;
  private autoInput = false;
  private message: MessageKey = "terminalSpeechReady";
  private lastView: SpeechView | undefined;

  constructor(private readonly terminal: Terminal, private readonly mount: HTMLElement) {
    this.voice.value = "zh-CN-XiaoxiaoNeural";
    this.rate.value = "1";
    try {
      const voice = localStorage.getItem("shelt-tts-voice");
      const rate = localStorage.getItem("shelt-tts-rate");
      if ([...this.voice.options].some((option) => option.value === voice)) this.voice.value = voice!;
      if ([...this.rate.options].some((option) => option.value === rate)) this.rate.value = rate!;
    } catch {}
    this.highlight = document.createElement("div");
    this.highlight.className = "terminal-speech-highlight";
    this.highlight.hidden = true;
    mount.querySelector(".xterm-screen")?.append(this.highlight);
    this.player = new TerminalSpeechPlayer(
      () => ({ voice: this.voice.value, rate: Number(this.rate.value) }),
      (state) => {
        this.pause.disabled = this.mode === "off" || this.mode === "target";
        this.pause.textContent = t(state === "paused" ? "resume" : "pause");
        if (state === "speaking" || state === "loading") this.setStatus(state === "speaking" ? "speaking" : "terminalSpeechLoading");
        if (state === "idle" && (this.mode === "read" || this.mode === "auto")) this.schedule(0);
      },
      () => this.stop("speechUnavailable"),
    );
    this.toggle.addEventListener("click", () => {
      const expanded = this.toolbar.classList.toggle("expanded");
      this.toggle.setAttribute("aria-expanded", String(expanded));
    });
    this.target.addEventListener("click", () => {
      const wasTargeting = this.mode === "target";
      this.stop();
      if (!wasTargeting) { this.mode = "target"; this.setStatus("terminalSpeechTargetHint"); }
      this.render();
    });
    this.auto.addEventListener("click", () => {
      if (this.mode === "auto") { this.stop(); return; }
      this.stop();
      const view = speechView(readSpeechGrid(terminal));
      if (!view || !this.transcript.update(view)) { this.setStatus("terminalSpeechUnavailable"); return; }
      this.anchor = { x: view.region.marker + 3, y: view.region.top + 1 };
      this.lastView = view;
      for (const block of this.transcript.blocks()) this.consumed.set(block.start, { text: block.text, end: block.text.length });
      this.mode = "auto";
      this.setStatus("terminalSpeechWaiting");
      this.render();
    });
    this.pause.addEventListener("click", () => {
      this.player.togglePause();
      if (this.player.paused) this.setStatus("paused");
      else this.schedule(0);
    });
    this.stopButton.addEventListener("click", () => this.stop());
    this.voice.addEventListener("change", () => { try { localStorage.setItem("shelt-tts-voice", this.voice.value); } catch {} });
    this.rate.addEventListener("change", () => { try { localStorage.setItem("shelt-tts-rate", this.rate.value); } catch {} });
    mount.addEventListener("mousedown", (event) => this.onPointer(event), true);
    mount.addEventListener("mouseup", (event) => {
      if (this.mode === "target" || this.mode === "read") { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    mount.addEventListener("click", (event) => {
      if (this.mode === "target" || this.mode === "read") { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    mount.addEventListener("wheel", () => {
      if (!this.ownWheel && (this.mode === "read" || this.mode === "auto")) this.stop("terminalSpeechInterrupted");
    }, true);
    mount.addEventListener("keydown", (event) => {
      if (this.mode === "off") return;
      if (this.mode !== "auto" || event.key === "Escape" || event.ctrlKey || event.altKey || event.metaKey || ["PageUp", "PageDown"].includes(event.key)) {
        this.stop("terminalSpeechInterrupted");
      } else if (event.key === "Enter") {
        this.autoInput = false;
        this.schedule(160);
      } else if (event.key.length === 1 || ["Backspace", "Delete", "Process"].includes(event.key)) {
        this.autoInput = true;
      }
    }, true);
    terminal.onWriteParsed(() => { if (this.mode === "read" || this.mode === "auto") this.schedule(160); });
    terminal.onResize(() => { if (this.mode !== "off") this.stop("terminalSpeechInterrupted"); });
    onLanguageChange(() => this.render());
    this.render();
  }

  setVisible(visible: boolean): void {
    this.toolbar.hidden = !visible;
    if (!visible) this.stop();
  }

  stop(message: MessageKey = "terminalSpeechReady"): void {
    this.mode = "off";
    this.player.stop();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.transcript = new SpeechTranscript();
    this.consumed.clear();
    this.anchor = undefined;
    this.lastView = undefined;
    this.searching = false;
    this.autoInput = false;
    this.scrollAttempts = 0;
    this.unchangedScrolls = 0;
    this.lastScrollSignature = "";
    this.highlight.hidden = true;
    this.setStatus(message);
    this.render();
  }

  private render(): void {
    this.target.textContent = t(this.mode === "target" ? "exitTargeting" : "targetRead");
    this.auto.textContent = t("terminalSpeechAuto");
    this.pause.textContent = t(this.player?.paused ? "resume" : "pause");
    this.stopButton.textContent = t("stop");
    this.target.setAttribute("aria-pressed", String(this.mode === "target" || this.mode === "read"));
    this.auto.setAttribute("aria-pressed", String(this.mode === "auto"));
    this.pause.disabled = this.mode !== "read" && this.mode !== "auto";
    this.stopButton.disabled = this.mode === "off";
    this.mount.classList.toggle("terminal-speech-targeting", this.mode === "target");
    this.toggle.setAttribute("aria-label", t("speechToolbar"));
    this.status.textContent = t(this.message);
    this.status.title = this.status.textContent;
  }

  private setStatus(message: MessageKey): void { this.message = message; this.status.textContent = t(message); this.status.title = this.status.textContent; }

  private onPointer(event: MouseEvent): void {
    if (event.button !== 0) return;
    if (this.mode !== "target") {
      if (this.mode === "auto" && this.lastView) {
        const screen = this.mount.querySelector(".xterm-screen")?.getBoundingClientRect();
        if (screen) {
          const x = (event.clientX - screen.left) * this.terminal.cols / screen.width;
          const y = (event.clientY - screen.top) * this.terminal.rows / screen.height;
          const region = this.lastView.region;
          if (x >= region.left && x < region.right && y > region.bottom && y < region.bottom + 3) return;
        }
      }
      if (this.mode !== "off") this.stop("terminalSpeechInterrupted");
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const screen = this.mount.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!screen) return;
    const x = Math.floor((event.clientX - screen.left) * this.terminal.cols / screen.width);
    const y = Math.floor((event.clientY - screen.top) * this.terminal.rows / screen.height);
    const view = speechView(readSpeechGrid(this.terminal), { x, y });
    const row = view?.rows.find((row) => row.row === y);
    if (!view || !row || row.kind === "boundary" || x < view.region.marker) { this.setStatus("terminalSpeechSelectBody"); return; }
    this.transcript = new SpeechTranscript();
    this.transcript.update(view);
    this.anchor = { x, y };
    this.selected = this.transcript.indexAtRow(y)!;
    const block = this.transcript.blockAt(this.selected);
    if (!block && view.rows.slice(0, view.rows.indexOf(row)).some((item) => item.kind === "boundary")) {
      this.setStatus("terminalSpeechSelectBody"); return;
    }
    this.mode = "read";
    this.searching = !block;
    this.lastView = view;
    this.setStatus(this.searching ? "terminalSpeechFindingStart" : "terminalSpeechLoading");
    this.render();
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.refresh(); }, delay);
  }

  private refresh(): void {
    if (this.mode !== "read" && this.mode !== "auto") return;
    const view = speechView(readSpeechGrid(this.terminal), this.anchor, this.lastView?.region);
    if (!view || !this.transcript.update(view)) { this.stop("terminalSpeechLostPosition"); return; }
    this.lastView = view;
    if (this.player.paused) return;
    if (this.searching) {
      const block = this.transcript.blockAt(this.selected);
      if (block) this.searching = false;
      else {
        const preceding = view.rows.find((row) => row.kind === "boundary" && (this.transcript.indexAtRow(row.row) ?? Infinity) < this.selected);
        if (preceding) { this.stop("terminalSpeechSelectBody"); return; }
        this.scroll(-1, view);
        return;
      }
    }
    const blocks = this.transcript.blocks().filter((block) => this.mode === "auto" || block.end >= this.selected);
    if (this.mode === "auto" && this.autoInput) {
      this.setStatus("terminalSpeechWaiting");
      return;
    }
    for (const block of blocks) {
      const previous = this.consumed.get(block.start) ?? { text: "", end: 0 };
      if (previous.end > 0 && block.text.slice(0, previous.end) !== previous.text.slice(0, previous.end)) {
        this.stop("terminalSpeechLostPosition"); return;
      }
      const stable = Date.now() - this.transcript.changedAt >= 1200;
      const part = readySpeechText(block.text, previous.end, block.closed || (this.mode === "read" && stable));
      for (const text of part.chunks) this.player.enqueue(text, () => this.highlightBlock(block.start, view.region));
      this.consumed.set(block.start, { text: block.text, end: part.end });
    }
    if (this.player.busy) return;
    if (this.mode === "auto") {
      this.setStatus("terminalSpeechWaiting");
      if (Date.now() - this.transcript.changedAt < 1200) this.schedule(1250);
      return;
    }
    if (Date.now() - this.transcript.changedAt < 1200) { this.schedule(1250); return; }
    this.scroll(1, view);
  }

  private highlightBlock(index: number, region: SpeechRegion): void {
    const screen = this.mount.querySelector<HTMLElement>(".xterm-screen");
    const row = this.transcript.rowAtIndex(index);
    if (!screen || row === undefined) { this.highlight.hidden = true; return; }
    this.highlight.hidden = false;
    this.highlight.style.left = `${region.marker * screen.clientWidth / this.terminal.cols}px`;
    this.highlight.style.top = `${row * screen.clientHeight / this.terminal.rows}px`;
    this.highlight.style.width = `${(region.right - region.marker) * screen.clientWidth / this.terminal.cols}px`;
    this.highlight.style.height = `${screen.clientHeight / this.terminal.rows}px`;
  }

  private scroll(direction: -1 | 1, view: SpeechView): void {
    if (!this.terminal.modes.mouseTrackingMode || this.terminal.modes.mouseTrackingMode === "none") {
      this.stop("terminalSpeechUnavailable"); return;
    }
    const signature = JSON.stringify(view.rows.map(({ text, kind }) => [kind, text]));
    this.unchangedScrolls = signature === this.lastScrollSignature ? this.unchangedScrolls + 1 : 0;
    this.lastScrollSignature = signature;
    if (this.unchangedScrolls >= 3 || ++this.scrollAttempts > 400) {
      this.stop(direction < 0 ? "terminalSpeechLostPosition" : "terminalSpeechVisibleEnd"); return;
    }
    const screen = this.mount.querySelector<HTMLElement>(".xterm-screen");
    const target = this.mount.querySelector<HTMLElement>(".xterm");
    if (!screen || !target) { this.stop("terminalSpeechUnavailable"); return; }
    const bounds = screen.getBoundingClientRect();
    this.setStatus(direction < 0 ? "terminalSpeechFindingStart" : "terminalSpeechScrolling");
    this.ownWheel = true;
    try {
      target.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: direction,
        clientX: bounds.left + (view.region.marker + 4) * bounds.width / this.terminal.cols,
        clientY: bounds.top + (view.region.top + 2) * bounds.height / this.terminal.rows,
      }));
    } finally { this.ownWheel = false; }
    this.schedule(400);
  }
}
