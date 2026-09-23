import { HTML_INTERACTIVE_KEY, htmlInteractiveEnabled } from "./preview-preferences.ts";
import type { PreviewTtsController } from "./tts.ts";
import { onLanguageChange, t, type MessageKey } from "./i18n.ts";

export async function mountHtmlPreview(mount: HTMLElement, path: string, apiUrl: string, tts: PreviewTtsController | null): Promise<void> {
  let generation = 0;
  let grant: string | null = null;
  let errorKey: MessageKey | null = null;
  const showError = (key: MessageKey) => { errorKey = key; mount.textContent = t(key); };
  onLanguageChange(() => { if (errorKey) mount.textContent = t(errorKey); });
  const revoke = (token: string) => fetch(`/api/preview-session/${token}`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => {});
  const render = async () => {
    const current = ++generation;
    const previous = grant;
    grant = null;
    errorKey = null;
    mount.replaceChildren();
    tts?.setDocument(null, undefined, "loadingPreview");
    if (previous) await revoke(previous);
    const interactive = htmlInteractiveEnabled();
    let url = apiUrl;
    if (interactive) {
      const response = await fetch("/api/preview-session", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
      });
      if (!response.ok) {
        if (current === generation) showError(response.status === 401 ? "previewLogin" : "interactiveLoadError");
        return;
      }
      const created = await response.json() as { token: string; url: string };
      if (current !== generation) { await revoke(created.token); return; }
      grant = created.token;
      url = created.url;
    }
    if (current !== generation) return;
    const frame = document.createElement("iframe");
    frame.sandbox.value = interactive ? "allow-scripts" : "allow-same-origin";
    frame.referrerPolicy = "no-referrer";
    frame.title = path.split("/").pop() || t("htmlPreview");
    if (interactive) {
      tts?.setDocument(null, undefined, "interactiveSpeechUnavailable");
    } else {
      frame.addEventListener("load", () => {
        if (current !== generation) return;
        try { tts?.setDocument(frame.contentDocument, frame); }
        catch { tts?.setDocument(null, undefined, "noReadable"); }
      });
    }
    frame.src = url;
    mount.replaceChildren(frame);
  };
  window.addEventListener("storage", (event) => {
    if (event.key === HTML_INTERACTIVE_KEY || event.key === null) void render().catch(() => showError("switchPreviewError"));
  });
  window.addEventListener("pagehide", () => {
    generation += 1;
    if (grant) { void revoke(grant); grant = null; }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void render().catch(() => showError("resumePreviewError"));
  });
  await render();
}
