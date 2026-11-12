import { MobileSender, mobileKey, nativeAgents, type NativeSnapshot, type MobileAgent } from "./mobile-model.ts";
import { MobileControl } from "./mobile-control.ts";
import { onLanguageChange, t } from "./i18n.ts";

const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Options = { write(data: string): boolean; focus(): void; upload(file: File): Promise<void> };
export class MobileController {
  pane: string | null = null;
  target = "";
  private agents: MobileAgent[] = [];
  private authenticated = false;
  private connected = false;
  private enabled = window.matchMedia("(max-width: 700px)").matches;
  private override = false;
  private composing = false;
  private ctrl = false;
  private selecting = false;
  private drafts = new Map<string, string>();
  private requestEpoch = 0;
  private repeat: ReturnType<typeof setTimeout> | undefined;
  private sender: MobileSender;
  private control: MobileControl;
  constructor(private options: Options) {
    this.sender = new MobileSender(data => this.connected && !this.selecting && this.options.write(data));
    this.control = new MobileControl(snapshot => this.applySnapshot(snapshot), () => { this.status(t("mobileUnavailable")); this.render(); });
    node("mobile-toggle").addEventListener("click", () => { this.override = true; this.enabled = !this.enabled; this.clearCtrl(); this.render(); });
    node("mobile-desktop").addEventListener("click", () => { this.override = true; this.enabled = false; this.clearCtrl(); this.render(); });
    window.matchMedia("(max-width: 700px)").addEventListener("change", e => { if (!this.override) { this.enabled = e.matches; this.render(); } });
    node("mobile-agents-toggle").addEventListener("click", () => { if (node("mobile-agents").hidden) this.openAgents(); else this.closeAgents(); });
    node("mobile-agents-close").addEventListener("click", () => this.closeAgents());
    node("mobile-refresh").addEventListener("click", () => { void this.refreshAgents(); });
    node("mobile-zoom").addEventListener("click", () => {
      if (this.pane && this.control.ready) void this.control.zoom(this.pane).catch(() => this.status(t("mobileUnavailable")));
    });
    const draft = node<HTMLTextAreaElement>("mobile-draft");
    let savedDraft = { value: "", start: 0, end: 0 };
    let consumedComposition = false;
    const snapshot = () => { savedDraft = { value: draft.value, start: draft.selectionStart, end: draft.selectionEnd }; };
    const restore = () => { draft.value = savedDraft.value; draft.setSelectionRange(savedDraft.start, savedDraft.end); };
    draft.addEventListener("compositionstart", () => { this.composing = true; if (this.ctrl) snapshot(); });
    draft.addEventListener("compositionend", event => {
      this.composing = false;
      if (this.ctrl) {
        restore(); this.sendControl(event.data); consumedComposition = true;
        setTimeout(() => { consumedComposition = false; }, 0);
      }
    });
    draft.addEventListener("keydown", event => {
      if (!this.ctrl || event.isComposing || ["Shift", "Control", "Alt", "Meta", "Process", "Dead", "Unidentified"].includes(event.key)) return;
      event.preventDefault();
      const key = event.key === "Escape" ? "Esc" : event.key;
      this.sendControl(key.length === 1 || ["Esc", "Tab", "Enter", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key) ? key : "");
    });
    draft.addEventListener("beforeinput", event => {
      if (consumedComposition) { if (event.cancelable) event.preventDefault(); return; }
      if (!this.ctrl || event.isComposing) return;
      snapshot();
      if (!event.cancelable) return;
      event.preventDefault(); this.sendControl(event.data ?? (event.inputType === "insertLineBreak" ? "Enter" : ""));
    });
    draft.addEventListener("input", event => {
      if (consumedComposition) { restore(); return; }
      if (this.ctrl) {
        if (this.composing) return;
        const data = (event as InputEvent).data ?? draft.value.slice(savedDraft.start, draft.value.length - (savedDraft.value.length - savedDraft.end));
        restore(); this.sendControl(data); return;
      }
      this.drafts.set(this.destination(), draft.value);
    });
    node("mobile-compose").addEventListener("submit", e => { e.preventDefault(); void this.submit(); });
    node("mobile-compose-toggle").addEventListener("click", () => {
      node("mobile-compose").hidden = !node("mobile-compose").hidden;
      window.dispatchEvent(new Event("resize")); if (!node("mobile-compose").hidden) draft.focus();
    });
    node("mobile-keyboard").addEventListener("click", () => { if (node("mobile-compose").hidden) this.options.focus(); else draft.focus(); });
    const keys = node("mobile-keys");
    for (const label of ["Esc", "Tab", "Shift+Tab", "Ctrl", "Ctrl+Y", "Ctrl+C", "C", "D", "L", "Z", "←", "↑", "↓", "→", "Enter"]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.dataset.key = label;
      if (label === "Ctrl") button.setAttribute("aria-pressed", "false");
      const act = () => {
        if (this.composing) return;
        if (label === "Ctrl") {
          this.ctrl = !this.ctrl; snapshot(); button.setAttribute("aria-pressed", String(this.ctrl));
          this.status(t(this.ctrl ? "mobileCtrlReady" : "mobileCtrlOff")); return;
        }
        if (this.ctrl && !label.startsWith("Ctrl+")) this.sendControl(label);
        else { this.sender.key(mobileKey(label)); this.clearCtrl(); }
      };
      button.addEventListener("pointerdown", e => {
        e.preventDefault();
        if (!["←", "↑", "↓", "→"].includes(label)) return;
        this.stopRepeat(); button.setPointerCapture(e.pointerId); act();
        const repeat = () => { act(); this.repeat = setTimeout(repeat, 80); };
        this.repeat = setTimeout(repeat, 400);
      });
      button.addEventListener("mousedown", e => e.preventDefault());
      button.addEventListener("click", e => { if (!["←", "↑", "↓", "→"].includes(label) || e.detail === 0) act(); });
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(name, () => this.stopRepeat());
      keys.append(button);
    }
    node("mobile-upload-button").addEventListener("pointerdown", e => e.preventDefault());
    node("mobile-upload-button").addEventListener("mousedown", e => e.preventDefault());
    node("mobile-upload-button").addEventListener("click", () => { if (!this.sender.busy && !this.composing && !this.selecting) node<HTMLInputElement>("mobile-upload").click(); });
    node<HTMLInputElement>("mobile-upload").addEventListener("change", e => {
      const input = e.target as HTMLInputElement, file = input.files?.[0]; input.value = "";
      if (file) void this.options.upload(file).catch(() => this.status(t("mobileUploadFailed")));
    });
    window.addEventListener("blur", () => this.stopRepeat());
    document.addEventListener("visibilitychange", () => { this.stopRepeat(); if (!document.hidden && this.authenticated) void this.refreshAgents(); });
    onLanguageChange(() => { this.renderAgents(); this.render(); });
  }
  destination(): string { return `${this.target}:${this.pane ?? "native"}`; }
  input(data: string): string {
    if (this.sender.busy || this.selecting) return "";
    if (this.ctrl) { this.sendControl(data); return ""; }
    this.sender.observe(data); return data;
  }
  private sendControl(data: string): void {
    const value = mobileKey(data, true);
    if (!value) { this.status(t("mobileCtrlUnsupported")); return; }
    if (!this.sender.key(value)) { this.status(t("mobileDraftKept")); return; }
    this.clearCtrl(); this.status(t("mobileCtrlSent"));
  }
  private clearCtrl(): void { this.ctrl = false; node("mobile-keys").querySelector('[data-key="Ctrl"]')?.setAttribute("aria-pressed", "false"); }
  connection(connected: boolean): void {
    this.connected = connected;
    if (!connected) { this.sender.cancel(); this.clearCtrl(); this.stopRepeat(); this.control.close(); }
    else if (this.authenticated) void this.refreshAgents();
    this.render();
  }
  setVisible(value: boolean): void {
    this.authenticated = value;
    if (value && this.connected) void this.refreshAgents();
    else if (!value) {
      this.requestEpoch++; this.control.close(); this.sender.cancel(); this.clearCtrl(); this.stopRepeat();
      this.pane = null; this.agents = []; this.closeAgents();
    }
    this.render();
  }
  targetChanged(): void {
    this.drafts.set(this.destination(), node<HTMLTextAreaElement>("mobile-draft").value);
    this.requestEpoch++; this.control.close(); this.sender.cancel(); this.clearCtrl(); this.stopRepeat(); this.closeAgents();
    this.pane = null; this.target = ""; this.agents = []; this.selecting = false;
    node<HTMLTextAreaElement>("mobile-draft").value = ""; this.render();
  }
  private applySnapshot(snapshot: NativeSnapshot): void {
    if (!this.authenticated) return;
    const pane = snapshot.focused_pane_id ?? null;
    if (pane !== this.pane) {
      this.drafts.set(this.destination(), node<HTMLTextAreaElement>("mobile-draft").value);
      this.sender.cancel(); this.clearCtrl(); this.stopRepeat(); this.pane = pane;
      node<HTMLTextAreaElement>("mobile-draft").value = this.drafts.get(this.destination()) ?? "";
    }
    this.agents = nativeAgents(snapshot); this.renderAgents(); this.render();
  }
  private openAgents(): void { node("mobile-agents").hidden = false; if (!this.control.ready) void this.refreshAgents(); }
  private closeAgents(): void { node("mobile-agents").hidden = true; }
  private async select(agent: MobileAgent): Promise<void> {
    if (this.sender.busy || this.composing || this.selecting || !this.control.ready) return;
    this.closeAgents();
    if (this.pane === agent.paneId) return;
    const epoch = this.requestEpoch;
    this.selecting = true; this.clearCtrl(); this.stopRepeat(); this.render();
    try { await this.control.focus(agent.paneId); if (epoch === this.requestEpoch) this.status(""); }
    catch { if (epoch === this.requestEpoch) this.status(t("mobileUnavailable")); }
    finally { if (epoch === this.requestEpoch) { this.selecting = false; this.render(); } }
  }
  async refreshAgents(): Promise<void> {
    if (!this.authenticated || !this.connected) return;
    if (this.control.ready) { await this.control.refresh().catch(() => this.status(t("mobileUnavailable"))); return; }
    const epoch = ++this.requestEpoch;
    try {
      const response = await fetch("/api/herdr/targets", { credentials: "same-origin" });
      if (!response.ok) throw new Error("unavailable");
      const result = await response.json() as { mode: string; active: string };
      if (epoch !== this.requestEpoch || !this.authenticated) return;
      this.target = result.active;
      if (result.mode === "herdr") this.control.connect(this.target);
      else this.status(t("mobileUnavailable"));
    } catch { if (epoch === this.requestEpoch) this.status(t("mobileUnavailable")); }
  }
  private renderAgents(): void {
    const list = node("mobile-agent-list"); list.replaceChildren();
    for (const agent of this.agents) {
      const button = document.createElement("button"); button.type = "button"; button.className = `mobile-agent status-${agent.status.replace(/[^a-z]/g, "")}`;
      const head = document.createElement("div"); head.className = "mobile-agent-head";
      const dot = document.createElement("span"); dot.className = "mobile-status-dot"; dot.setAttribute("aria-hidden", "true");
      const title = document.createElement("strong"); title.textContent = agent.title;
      head.append(dot, title);
      const meta = document.createElement("span"); meta.textContent = `${agent.status} · ${agent.cwd}`;
      button.append(head, meta); button.setAttribute("aria-pressed", String(this.pane === agent.paneId));
      button.addEventListener("click", () => { void this.select(agent); }); list.append(button);
    }
    if (!this.agents.length) list.textContent = t("mobileNoAgents");
  }
  async submit(): Promise<void> {
    if (this.composing || !this.connected || this.selecting) return;
    const draft = node<HTMLTextAreaElement>("mobile-draft"), text = draft.value, key = this.destination(), epoch = this.requestEpoch;
    const promise = this.sender.submit(text); this.render();
    const sent = await promise;
    if (key !== this.destination() || epoch !== this.requestEpoch) { this.render(); return; }
    if (sent && draft.value === text) { draft.value = ""; this.drafts.delete(key); }
    this.status(t(sent ? "mobileSent" : "mobileDraftKept")); this.render();
  }
  private status(value: string): void { node("mobile-status").textContent = value; }
  private stopRepeat(): void { clearTimeout(this.repeat); this.repeat = undefined; }
  private render(): void {
    const visible = this.authenticated && this.enabled;
    const layoutChanged = document.body.classList.contains("mobile-enabled") !== visible;
    document.body.classList.toggle("mobile-enabled", visible);
    node("mobile-toggle").hidden = !this.authenticated || visible;
    node("mobile-toggle").setAttribute("aria-pressed", String(this.enabled));
    node("mobile-desktop").textContent = t("mobileDesktop");
    node("mobile-header").hidden = !visible; node("mobile-controls").hidden = !visible;
    node("mobile-agents-toggle").textContent = t("mobileAgents");
    node("mobile-zoom").textContent = t("mobileZoom");
    node<HTMLButtonElement>("mobile-zoom").disabled = !this.pane || !this.control.ready;
    node("mobile-current").textContent = this.agents.find(a => a.paneId === this.pane)?.title ?? "Herdr";
    node("mobile-current").title = node("mobile-current").textContent ?? "";
    const disabled = !this.connected || this.sender.busy || this.selecting;
    node<HTMLButtonElement>("mobile-send").disabled = disabled;
    node<HTMLTextAreaElement>("mobile-draft").readOnly = this.sender.busy;
    for (const button of node("mobile-keys").querySelectorAll<HTMLButtonElement>("button")) button.disabled = disabled;
    node<HTMLButtonElement>("mobile-upload-button").disabled = disabled;
    if (!visible) this.closeAgents();
    if (layoutChanged) window.dispatchEvent(new Event("resize"));
  }
}
