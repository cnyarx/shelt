import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../src/notify-preferences.ts", import.meta.url), "utf8").replaceAll("export ", "") + "\n" +
  readFileSync(new URL("../src/agent-notifications.ts", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?from ".*?";\n/gm, "")
    .replaceAll("export ", ""),
);

type Sent = { title: string; body: string; tag: string };

function boot(options: { permission?: string; storage?: Record<string, string> } = {}) {
  const storage = new Map<string, string>(Object.entries(options.storage ?? {}));
  const sent: Sent[] = [];
  const sources: { url: string; closed: boolean; onmessage: ((event: { data: string }) => void) | null }[] = [];
  const storageHandlers: ((event: { key: string | null }) => void)[] = [];
  class FakeNotification {
    static permission = options.permission ?? "granted";
    onclick: (() => void) | null = null;
    constructor(public title: string, public init: { body: string; tag: string }) {
      sent.push({ title, body: init.body, tag: init.tag });
    }
    close() {}
  }
  class FakeEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) { sources.push(this); }
    close() { this.closed = true; }
  }
  const sandbox: any = {
    t: (key: string) => key,
    Notification: FakeNotification,
    EventSource: FakeEventSource,
    window: {
      addEventListener: (_name: string, handler: (event: { key: string | null }) => void) => storageHandlers.push(handler),
      focus() {},
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  };
  sandbox.window.Notification = FakeNotification;
  runInNewContext(
    `${source}\nglobalThis.__handle = handleAgentEventMessage;\nglobalThis.__sync = syncAgentNotifications;\nglobalThis.__setup = setupAgentNotifications;`,
    sandbox,
  );
  return {
    sent,
    sources,
    handle: sandbox.__handle as (message: unknown) => void,
    sync: sandbox.__sync as () => void,
    setup: sandbox.__setup as () => void,
    fireStorage: (key: string | null) => { for (const handler of storageHandlers) handler({ key }); },
    setStorage: (key: string, value: string) => storage.set(key, value),
  };
}

const snapshot = (agents: { paneId: string; status: string }[]) =>
  ({ type: "snapshot", agents: agents.map((agent) => ({ ...agent, title: `Agent ${agent.paneId}`, agent: "qwen", cwd: "/tmp" })) });
const status = (paneId: string, next: string) => ({ type: "status", paneId, status: next, title: `Agent ${paneId}`, agent: "qwen" });

test("snapshot seeds the baseline without notifying", () => {
  const fixture = boot({ storage: { "shelt-notify-done": "true" } });
  fixture.handle(snapshot([{ paneId: "w2:p7", status: "done" }, { paneId: "w2:p8", status: "blocked" }]));
  expect(fixture.sent).toEqual([]);
});

test("working to done notifies when the done toggle is on", () => {
  const fixture = boot({ storage: { "shelt-notify-done": "true" } });
  fixture.handle(snapshot([{ paneId: "w2:p7", status: "working" }]));
  fixture.handle(status("w2:p7", "done"));
  expect(fixture.sent).toEqual([
    { title: "notifyDoneTitle", body: "Agent w2:p7", tag: "shelt-agent-w2:p7-done" },
  ]);
});

test("working to blocked notifies when the blocked toggle is on", () => {
  const fixture = boot({ storage: { "shelt-notify-blocked": "true" } });
  fixture.handle(snapshot([{ paneId: "w2:p9", status: "working" }]));
  fixture.handle(status("w2:p9", "blocked"));
  expect(fixture.sent).toEqual([
    { title: "notifyBlockedTitle", body: "Agent w2:p9", tag: "shelt-agent-w2:p9-blocked" },
  ]);
});

test("toggles off suppress notifications", () => {
  const fixture = boot();
  fixture.handle(snapshot([{ paneId: "w2:p7", status: "working" }, { paneId: "w2:p8", status: "working" }]));
  fixture.handle(status("w2:p7", "done"));
  fixture.handle(status("w2:p8", "blocked"));
  expect(fixture.sent).toEqual([]);
});

test("unchanged statuses and non-alert transitions stay silent", () => {
  const fixture = boot({ storage: { "shelt-notify-done": "true", "shelt-notify-blocked": "true" } });
  fixture.handle(snapshot([{ paneId: "w2:p7", status: "working" }]));
  fixture.handle(status("w2:p7", "working"));
  fixture.handle(status("w2:p7", "done"));
  fixture.handle(status("w2:p7", "done"));
  fixture.handle(status("w2:p7", "idle"));
  fixture.handle(status("w2:p7", "working"));
  expect(fixture.sent).toEqual([
    { title: "notifyDoneTitle", body: "Agent w2:p7", tag: "shelt-agent-w2:p7-done" },
  ]);
});

test("a pane that reappears after removal notifies on its next completion", () => {
  const fixture = boot({ storage: { "shelt-notify-done": "true" } });
  fixture.handle(snapshot([{ paneId: "w2:p7", status: "working" }]));
  fixture.handle({ type: "removed", paneId: "w2:p7" });
  fixture.handle(status("w2:p7", "working"));
  fixture.handle(status("w2:p7", "done"));
  expect(fixture.sent).toEqual([
    { title: "notifyDoneTitle", body: "Agent w2:p7", tag: "shelt-agent-w2:p7-done" },
  ]);
});

test("status for an unknown pane only records the baseline", () => {
  const fixture = boot({ storage: { "shelt-notify-done": "true" } });
  fixture.handle(status("w2:p7", "done"));
  expect(fixture.sent).toEqual([]);
});

test("notifications are skipped without the granted permission", () => {
  const fixture = boot({ permission: "denied", storage: { "shelt-notify-done": "true" } });
  fixture.handle(snapshot([{ paneId: "w2:p7", status: "working" }]));
  fixture.handle(status("w2:p7", "done"));
  expect(fixture.sent).toEqual([]);
});

test("the event stream opens and closes with the toggles", () => {
  const fixture = boot();
  fixture.sync();
  expect(fixture.sources).toEqual([]);

  fixture.setStorage("shelt-notify-done", "true");
  fixture.sync();
  expect(fixture.sources).toHaveLength(1);
  expect(fixture.sources[0].url).toBe("/api/herdr/agent-events");
  expect(fixture.sources[0].closed).toBe(false);

  fixture.sync();
  expect(fixture.sources).toHaveLength(1);

  fixture.setStorage("shelt-notify-done", "false");
  fixture.setStorage("shelt-notify-blocked", "true");
  fixture.sync();
  expect(fixture.sources).toHaveLength(1);
  expect(fixture.sources[0].closed).toBe(false);

  fixture.setStorage("shelt-notify-blocked", "false");
  fixture.sync();
  expect(fixture.sources[0].closed).toBe(true);
  fixture.sync();
  expect(fixture.sources).toHaveLength(1);
});

test("storage events from other tabs resync the stream", () => {
  const fixture = boot();
  fixture.setup();
  expect(fixture.sources).toEqual([]);
  fixture.setStorage("shelt-notify-blocked", "true");
  fixture.fireStorage("shelt-notify-blocked");
  expect(fixture.sources).toHaveLength(1);
  fixture.setStorage("shelt-notify-blocked", "false");
  fixture.fireStorage("shelt-notify-blocked");
  expect(fixture.sources[0].closed).toBe(true);
});

test("snapshot events from the stream rebuild the baseline", () => {
  const fixture = boot({ storage: { "shelt-notify-done": "true" } });
  fixture.setStorage("shelt-notify-done", "true");
  fixture.sync();
  const stream = fixture.sources[0];
  stream.onmessage?.({ data: JSON.stringify(snapshot([{ paneId: "w2:p7", status: "working" }])) });
  stream.onmessage?.({ data: JSON.stringify(status("w2:p7", "done")) });
  expect(fixture.sent).toEqual([
    { title: "notifyDoneTitle", body: "Agent w2:p7", tag: "shelt-agent-w2:p7-done" },
  ]);
});
