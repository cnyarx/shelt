const READABLE_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,th,td";
export const MAX_TTS_TEXT_CHARS = 1000;

export type ReadableBlock = { element: HTMLElement; text: string; frame?: HTMLIFrameElement };
type ReaderState = "idle" | "loading" | "speaking" | "paused";

export function normalizeTtsText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function splitTtsText(value: string, maxChars = MAX_TTS_TEXT_CHARS): string[] {
  const text = normalizeTtsText(value);
  if (!text) return [];
  const result: string[] = [];
  let remaining = [...text];
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const minimumBoundary = Math.floor(maxChars * 0.4);
    let cut = -1;
    for (let index = Math.min(maxChars, window.length - 1); index >= minimumBoundary; index -= 1) {
      if (/[。！？；.!?;]/u.test(window[index]!)) {
        cut = index + 1;
        break;
      }
    }
    if (cut < 0) {
      for (let index = Math.min(maxChars, window.length - 1); index >= minimumBoundary; index -= 1) {
        if (/\s/u.test(window[index]!)) {
          cut = index;
          break;
        }
      }
    }
    if (cut < 0) cut = maxChars;
    result.push(remaining.slice(0, cut).join("").trim());
    remaining = [...remaining.slice(cut).join("").trim()];
  }
  if (remaining.length) result.push(remaining.join(""));
  return result;
}

export function collectReadableBlocks(root: ParentNode, frame?: HTMLIFrameElement): ReadableBlock[] {
  return [...root.querySelectorAll<HTMLElement>(READABLE_SELECTOR)].flatMap((element) => {
    const styles = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (element.closest("#tts-toolbar") || element.hidden || styles?.display === "none" || styles?.visibility === "hidden") return [];
    const copy = element.cloneNode(true) as HTMLElement;
    for (const nested of copy.querySelectorAll(READABLE_SELECTOR)) nested.remove();
    const text = normalizeTtsText(copy.textContent ?? "");
    return text ? [{ element, text, frame }] : [];
  });
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`TTS UI missing: ${id}`);
  return element as T;
}

export class PreviewTtsController {
  private readonly toolbar = requiredElement<HTMLElement>("tts-toolbar");
  private readonly toggleButton = requiredElement<HTMLButtonElement>("tts-toggle");
  private readonly startButton = requiredElement<HTMLButtonElement>("tts-start");
  private readonly targetButton = requiredElement<HTMLButtonElement>("tts-target");
  private readonly pauseButton = requiredElement<HTMLButtonElement>("tts-pause");
  private readonly stopButton = requiredElement<HTMLButtonElement>("tts-stop");
  private readonly voiceSelect = requiredElement<HTMLSelectElement>("tts-voice");
  private readonly rateSelect = requiredElement<HTMLSelectElement>("tts-rate");
  private readonly status = requiredElement<HTMLElement>("tts-status");
  private blocks: ReadableBlock[] = [];
  private highlighted: HTMLElement | undefined;
  private abortController: AbortController | undefined;
  private audio: HTMLAudioElement | undefined;
  private cancelPlayback: (() => void) | undefined;
  private queueToken = 0;
  private state: ReaderState = "idle";
  private targeting = false;
  private targetingCleanup: (() => void) | undefined;

  constructor() {
    this.voiceSelect.value = localStorage.getItem("shelt-tts-voice") || "zh-CN-XiaoxiaoNeural";
    this.rateSelect.value = localStorage.getItem("shelt-tts-rate") || "1";
    this.toggleButton.addEventListener("click", () => this.setExpanded(this.toolbar.classList.contains("collapsed")));
    this.startButton.addEventListener("click", () => {
      if (this.blocks.length > 0) void this.speakFrom(0);
    });
    this.targetButton.addEventListener("click", () => this.setTargeting(!this.targeting));
    this.pauseButton.addEventListener("click", () => this.togglePause());
    this.stopButton.addEventListener("click", () => this.stop());
    this.voiceSelect.addEventListener("change", () => localStorage.setItem("shelt-tts-voice", this.voiceSelect.value));
    this.rateSelect.addEventListener("change", () => localStorage.setItem("shelt-tts-rate", this.rateSelect.value));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.targeting) this.setTargeting(false);
    });
  }

  private setExpanded(expanded: boolean): void {
    this.toolbar.classList.toggle("collapsed", !expanded);
    this.toggleButton.setAttribute("aria-expanded", String(expanded));
    this.toggleButton.setAttribute("aria-label", expanded ? "收起语音朗读工具栏" : "展开语音朗读工具栏");
  }

  setDocument(root: ParentNode | null, frame?: HTMLIFrameElement, emptyMessage = "此预览没有可朗读内容"): void {
    this.stop();
    if (root?.nodeType === Node.DOCUMENT_NODE) this.installFrameHighlightStyle(root as Document);
    this.blocks = root ? collectReadableBlocks(root, frame) : [];
    this.startButton.disabled = this.blocks.length === 0;
    this.targetButton.disabled = this.blocks.length === 0;
    this.setStatus(this.blocks.length ? "就绪" : emptyMessage);
    this.installTargeting(root);
  }

  private installFrameHighlightStyle(document: Document): void {
    const style = document.createElement("style");
    style.textContent = ".tts-speaking{outline:3px solid rgb(9 105 218 / 55%);outline-offset:3px;border-radius:3px;background-color:rgb(9 105 218 / 8%)!important}";
    document.head?.append(style);
  }

  private installTargeting(root: ParentNode | null): void {
    this.targetingCleanup?.();
    if (!root) { this.targetingCleanup = undefined; return; }
    const eventRoot = root instanceof Document ? root : document;
    const handler = (event: Event) => {
      if (!this.targeting) return;
      const eventElement = event.target instanceof Element ? event.target : null;
      if (eventElement?.closest("#tts-toolbar")) return;
      const target = eventElement?.closest<HTMLElement>(READABLE_SELECTOR) ?? null;
      const block = target ? this.blocks.find((item) => item.element === target) : undefined;
      if (!block) { this.setTargeting(false); return; }
      event.preventDefault();
      const index = this.blocks.indexOf(block);
      if (index >= 0) void this.speakFrom(index);
    };
    eventRoot.addEventListener("click", handler, true);
    this.targetingCleanup = () => eventRoot.removeEventListener("click", handler, true);
  }

  private setTargeting(enabled: boolean): void {
    this.targeting = enabled && this.blocks.length > 0;
    this.targetButton.setAttribute("aria-pressed", String(this.targeting));
    this.targetButton.classList.toggle("active", this.targeting);
    this.targetButton.textContent = this.targeting ? "退出定位" : "定位朗读";
    this.setStatus(this.targeting ? "请点击要开始朗读的内容" : this.state === "idle" ? "就绪" : this.status.textContent || "就绪");
  }

  private async speakFrom(index: number): Promise<void> {
    this.stop();
    this.setTargeting(false);
    const token = ++this.queueToken;
    this.abortController = new AbortController();

    try {
      const chunks: { text: string; element: HTMLElement }[] = [];
      for (let blockIndex = index; blockIndex < this.blocks.length; blockIndex++) {
        const block = this.blocks[blockIndex]!;
        for (const text of splitTtsText(block.text)) {
          chunks.push({ text, element: block.element });
        }
      }
      if (chunks.length === 0) { this.setState("idle", "朗读完成"); return; }

      let nextAudio: Promise<string | null> = this.fetchTtsAudio(chunks[0]!.text);

      for (let i = 0; i < chunks.length && token === this.queueToken; i++) {
        const { text, element } = chunks[i]!;
        this.highlight(element);

        const url = await nextAudio;
        if (token !== this.queueToken || this.abortController.signal.aborted) return;

        if (i + 1 < chunks.length) {
          nextAudio = this.fetchTtsAudio(chunks[i + 1]!.text);
        }

        if (!url) throw new Error("Online TTS unavailable");
        this.setState("speaking", "正在使用在线神经语音朗读");
        await this.playAudio(url, token);
        URL.revokeObjectURL(url);
      }

      if (token === this.queueToken) {
        this.clearHighlight();
        this.setState("idle", "朗读完成");
      }
    } catch {
      if (token === this.queueToken) {
        this.clearHighlight();
        this.setState("idle", "语音朗读不可用");
      }
    } finally {
      if (this.abortController && token === this.queueToken) {
        this.abortController = undefined;
      }
    }
  }

  private async fetchTtsAudio(text: string): Promise<string | null> {
    if (!this.abortController) return null;
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: this.voiceSelect.value, rate: Number(this.rateSelect.value) }),
        signal: this.abortController.signal,
      });
      if (!response.ok) return null;
      return URL.createObjectURL(await response.blob());
    } catch {
      return null;
    }
  }

  private playAudio(url: string, token: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (this.audio === audio) this.audio = undefined;
        this.cancelPlayback = undefined;
        error ? reject(error) : resolve();
      };
      this.audio = audio;
      this.cancelPlayback = () => finish();
      audio.addEventListener("ended", () => finish(), { once: true });
      audio.addEventListener("error", () => finish(new Error("Audio playback failed")), { once: true });
      void audio.play().catch((error) => finish(error instanceof Error ? error : new Error("Audio playback failed")));
      if (token !== this.queueToken) {
        audio.pause();
        finish();
      }
    });
  }

  private togglePause(): void {
    if (this.state === "paused") {
      void this.audio?.play();
      this.setState("speaking", "继续朗读");
      return;
    }
    this.audio?.pause();
    this.setState("paused", "已暂停");
  }

  stop(): void {
    this.queueToken += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.cancelPlayback?.();
    this.cancelPlayback = undefined;
    this.audio?.pause();
    this.audio = undefined;
    this.clearHighlight();
    this.setState("idle", this.blocks.length ? "就绪" : "正在加载预览…");
  }

  private highlight(element: HTMLElement): void {
    this.clearHighlight();
    this.highlighted = element;
    element.classList.add("tts-speaking");
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  private clearHighlight(): void {
    this.highlighted?.classList.remove("tts-speaking");
    this.highlighted = undefined;
  }

  private setState(state: ReaderState, message: string): void {
    this.state = state;
    this.pauseButton.disabled = state !== "speaking" && state !== "paused";
    this.pauseButton.textContent = state === "paused" ? "继续" : "暂停";
    this.stopButton.disabled = state === "idle";
    this.setStatus(message);
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }
}