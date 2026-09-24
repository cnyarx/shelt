import { t } from "./i18n.ts";
import {
  NOTIFY_BLOCKED_KEY,
  NOTIFY_DONE_KEY,
  notifyBlockedEnabled,
  notifyDoneEnabled,
} from "./notify-preferences.ts";

type Agent = { paneId: string; status: string; title: string; agent: string; cwd: string };
type BridgeMessage =
  | { type: "snapshot"; agents: Agent[] }
  | { type: "status"; paneId: string; status: string; title: string; agent: string }
  | { type: "removed"; paneId: string };

let statuses = new Map<string, string>();
let source: EventSource | null = null;

export function agentNotificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

export function requestAgentNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return Promise.resolve("unsupported");
  return Notification.requestPermission().catch(() => Notification.permission as NotificationPermission);
}

function notify(paneId: string, status: "done" | "blocked", title: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const notice = new Notification(t(status === "done" ? "notifyDoneTitle" : "notifyBlockedTitle"), {
      body: title || paneId,
      tag: `shelt-agent-${paneId}-${status}`,
    });
    notice.onclick = () => { notice.close(); window.focus(); };
  } catch { /* notification failures must not break the event stream */ }
}

export function handleAgentEventMessage(message: BridgeMessage): void {
  if (message.type === "snapshot") {
    // A snapshot is the current state, not a transition; it only seeds the
    // baseline so later changes can be detected.
    statuses = new Map(message.agents.map((agent) => [agent.paneId, agent.status]));
    return;
  }
  if (message.type === "removed") {
    statuses.delete(message.paneId);
    return;
  }
  const previous = statuses.get(message.paneId);
  statuses.set(message.paneId, message.status);
  if (previous === undefined || previous === message.status) return;
  if (message.status === "done" && notifyDoneEnabled()) notify(message.paneId, "done", message.title);
  if (message.status === "blocked" && notifyBlockedEnabled()) notify(message.paneId, "blocked", message.title);
}

export function syncAgentNotifications(): void {
  const wanted = notifyDoneEnabled() || notifyBlockedEnabled();
  if (!wanted) {
    source?.close();
    source = null;
    statuses.clear();
    return;
  }
  if (source) return;
  source = new EventSource("/api/herdr/agent-events");
  source.onmessage = (event) => {
    try { handleAgentEventMessage(JSON.parse(event.data) as BridgeMessage); } catch { /* ignore malformed frames */ }
  };
  source.onerror = () => { /* EventSource reconnects automatically */ };
}

export function setupAgentNotifications(): void {
  syncAgentNotifications();
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === NOTIFY_DONE_KEY || event.key === NOTIFY_BLOCKED_KEY) {
      syncAgentNotifications();
    }
  });
}
