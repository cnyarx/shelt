export type MobileAgent = { paneId: string; title: string; workspace: string; cwd: string; status: string; kind: string };
export type NativeSnapshot = {
  focused_pane_id?: string | null;
  workspaces: { workspace_id: string; label?: string }[];
  tabs: { tab_id: string; workspace_id: string; label?: string }[];
  agents: { pane_id: string; workspace_id: string; tab_id: string; name?: string; terminal_title_stripped?: string; agent?: string; agent_status?: string; cwd?: string }[];
};
export const NATIVE_EVENTS = [
  "workspace.created", "workspace.closed", "workspace.renamed", "workspace.moved", "workspace.reordered", "workspace.focused",
  "tab.created", "tab.closed", "tab.renamed", "tab.moved", "tab.focused",
  "pane.created", "pane.closed", "pane.updated", "pane.focused", "pane.moved", "pane.exited", "pane.agent_detected", "layout.updated",
] as const;

export function validPane(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value); }

export function nativeAgents(snapshot: NativeSnapshot): MobileAgent[] {
  const workspaces = new Map(snapshot.workspaces.map((w, index) => [w.workspace_id, { ...w, index }]));
  const tabs = new Map(snapshot.tabs.map((tab, index) => [tab.tab_id, { ...tab, index }]));
  return [...snapshot.agents].sort((a, b) => (workspaces.get(a.workspace_id)?.index ?? workspaces.size) - (workspaces.get(b.workspace_id)?.index ?? workspaces.size)
    || (tabs.get(a.tab_id)?.index ?? tabs.size) - (tabs.get(b.tab_id)?.index ?? tabs.size)).map(a => {
    const workspace = workspaces.get(a.workspace_id)?.label || a.workspace_id;
    const tab = tabs.get(a.tab_id)?.label || a.tab_id;
    return { paneId: a.pane_id, title: [workspace, tab, a.name || a.terminal_title_stripped || a.agent || a.pane_id].filter(Boolean).join(" · "),
      workspace, cwd: a.cwd || "", status: a.agent_status || "unknown", kind: a.agent || "" };
  });
}

export function mobileKey(key: string, ctrl = false): string {
  if (ctrl) {
    if (/^[a-z]/i.test(key)) {
      if (key.length === 1 || !["Esc", "Tab", "Enter", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Shift+Tab"].includes(key)) return String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
    }
    return ({ " ": "\x00", "@": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "_": "\x1f", "?": "\x7f", "↑": "\x1b[1;5A", "↓": "\x1b[1;5B", "→": "\x1b[1;5C", "←": "\x1b[1;5D", ArrowUp: "\x1b[1;5A", ArrowDown: "\x1b[1;5B", ArrowRight: "\x1b[1;5C", ArrowLeft: "\x1b[1;5D", Enter: "\r", Tab: "\t", Esc: "\x1b", Backspace: "\x08", "Shift+Tab": "\x1b[Z" } as Record<string, string>)[key] ?? (/^[\x00-\x1f\x7f]$/.test(key) ? key : "");
  }
  return ({ Esc: "\x1b", Tab: "\t", "Shift+Tab": "\x1b[Z", Enter: "\r", "Ctrl+C": "\x03", "Ctrl+Y": "\x19", "↑": "\x1b[A", "↓": "\x1b[B", "→": "\x1b[C", "←": "\x1b[D" } as Record<string, string>)[key] ?? key;
}

export class MobileSender {
  private lastEscape = -Infinity;
  private generation = 0;
  busy = false;
  constructor(private write: (value: string) => boolean, private wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), private now = () => Date.now()) {}
  cancel(): void { this.generation++; }
  observe(value: string): void { if (value === "\x1b") this.lastEscape = this.now(); }
  key(value: string): boolean {
    if (this.busy) return false;
    this.observe(value);
    return this.write(value);
  }
  async submit(text: string): Promise<boolean> {
    if (this.busy || !text.trim() || text.length > 60000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return false;
    this.busy = true; const generation = this.generation;
    try {
      if (!this.write(`\x1b[200~${text.replace(/\r\n?/g, "\n")}\x1b[201~`)) return false;
      await this.wait(Math.max(120, 300 - (this.now() - this.lastEscape)));
      return generation === this.generation && this.write("\r");
    } finally { this.busy = false; }
  }
}
