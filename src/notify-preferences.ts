export const NOTIFY_DONE_KEY = "shelt-notify-done";
export const NOTIFY_BLOCKED_KEY = "shelt-notify-blocked";

export function notifyDoneEnabled(): boolean {
  try { return localStorage.getItem(NOTIFY_DONE_KEY) === "true"; }
  catch { return false; }
}

export function setNotifyDone(enabled: boolean): void {
  localStorage.setItem(NOTIFY_DONE_KEY, String(enabled));
}

export function notifyBlockedEnabled(): boolean {
  try { return localStorage.getItem(NOTIFY_BLOCKED_KEY) === "true"; }
  catch { return false; }
}

export function setNotifyBlocked(enabled: boolean): void {
  localStorage.setItem(NOTIFY_BLOCKED_KEY, String(enabled));
}
