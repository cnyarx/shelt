import { localizedError, onLanguageChange, t, type MessageKey } from "./i18n.ts";

type UpdateStatus = { currentVersion: string; latestVersion: string | null; available: boolean; canInstall: boolean; reason: string | null; phase: string; error: string | null };

export function setupUpdates(): { check: () => Promise<void>; active: () => boolean } {
  const button = document.getElementById("update-install") as HTMLButtonElement;
  const dot = document.getElementById("update-dot")!;
  const status = document.getElementById("update-status")!;
  const toggle = document.getElementById("settings-toggle")!;
  let result: UpdateStatus | undefined;
  let message: (() => string) | undefined;
  let nextCheck = 0;
  let checking = false;
  let installing = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let restartDeadline = 0;
  const render = () => {
    dot.hidden = !result?.available;
    button.hidden = !result?.available;
    button.disabled = installing || !result?.canInstall;
    button.textContent = t(installing ? "updateInstalling" : "updateInstall", { version: result?.latestVersion || "" });
    status.textContent = message ? message() : result?.error ? localizedError(result.error) : result?.available && result.reason ? localizedError(result.reason) : result?.available ? t("updateFound", { version: result.latestVersion! }) : "";
    toggle.setAttribute("aria-label", result?.available ? `${t("settings")} · ${t("updateFound", { version: result.latestVersion! })}` : t("settings"));
  };
  onLanguageChange(render);
  const poll = () => { clearTimeout(pollTimer); if (installing) pollTimer = setTimeout(() => void check(), 1500); };
  const check = async () => {
    if (toggle.hidden || (document.hidden && !installing) || checking || (!installing && Date.now() < nextCheck)) return;
    checking = true;
    try {
      const response = await fetch("/api/update", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(25_000) });
      if (response.status === 401) {
        if (installing) { location.reload(); return; }
        return;
      }
      if (!response.ok) throw new Error("updateCheckFailed");
      result = await response.json() as UpdateStatus;
      nextCheck = Date.now() + (result.error ? 300_000 : 3_600_000);
      if (["downloading", "verifying", "restarting"].includes(result.phase)) {
        installing = true;
        if (!restartDeadline) restartDeadline = Date.now() + 12 * 60_000;
        const key = `update${result.phase[0]!.toUpperCase()}${result.phase.slice(1)}` as MessageKey;
        message = () => t(key);
      } else {
        installing = false;
        restartDeadline = 0;
        message = undefined;
      }
    } catch (error) {
      if (!installing) { message = () => localizedError(error); nextCheck = Date.now() + 300_000; }
    } finally {
      checking = false;
      if (installing && Date.now() > restartDeadline) {
        installing = false;
        message = () => t("updateRestartTimeout");
      }
      render();
      poll();
    }
  };
  button.addEventListener("click", async () => {
    if (installing || !result?.available || !result.canInstall || !confirm(t("updateConfirm", { version: result.latestVersion! }))) return;
    installing = true;
    restartDeadline = Date.now() + 12 * 60_000;
    message = () => t("updateDownloading");
    render();
    try {
      const response = await fetch("/api/update", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: "updateFailed" })) as { error: string };
        throw new Error(body.error);
      }
      nextCheck = 0;
    } catch (error) {
      installing = false;
      message = () => localizedError(error);
      render();
    }
    poll();
  });
  new MutationObserver(() => { if (!toggle.hidden) void check(); }).observe(toggle, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
  setInterval(() => void check(), 3_600_000);
  void check();
  return { check, active: () => installing };
}
