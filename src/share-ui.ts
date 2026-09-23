import { getLanguage, localizedError, onLanguageChange, t } from "./i18n.ts";

export function setupShare(path: string): void {
  const toolbar = document.getElementById("share-toolbar")!;
  const toggle = document.getElementById("share-toggle")!;
  const panel = document.getElementById("share-panel")!;
  const status = document.getElementById("share-status")!;
  const create = document.getElementById("share-create") as HTMLButtonElement;
  const revoke = document.getElementById("share-revoke") as HTMLButtonElement;
  const input = document.getElementById("share-url") as HTMLInputElement;
  const api = `/api/shares?path=${encodeURIComponent(path)}`;
  let link = "";
  let expiry: number | null = null;
  let feedback: (() => string) | null = () => t("loadingShare");
  toolbar.hidden = false;
  const ttsToolbar = document.getElementById("tts-toolbar")!;
  new ResizeObserver(() => {
    toolbar.style.top = ttsToolbar.classList.contains("collapsed") ? "" : `${ttsToolbar.getBoundingClientRect().bottom + 8}px`;
  }).observe(ttsToolbar);
  let busy = false;
  const setBusy = (value: boolean) => {
    busy = value;
    create.disabled = busy;
    revoke.disabled = busy || !expiry;
  };
  const renderText = () => {
    create.textContent = t(link ? "copyShare" : expiry ? "regenerateShare" : "createShare");
    status.textContent = feedback ? feedback() : expiry
      ? t("shareExpires", { date: new Date(expiry * 1000).toLocaleString(getLanguage()) }) + (link ? "" : t("shareUnrecoverable"))
      : t("shareInfo");
  };
  const showFeedback = (message: () => string) => { feedback = message; renderText(); };
  const update = () => {
    feedback = null;
    renderText();
    setBusy(busy);
    input.hidden = !link;
    input.value = link;
  };
  onLanguageChange(renderText);
  renderText();
  const request = async (method: string) => {
    const response = await fetch(api, { method, credentials: "same-origin" });
    if (!response.ok) throw new Error(response.status === 401 ? "Authentication required" : await response.text());
    return response.json();
  };
  toggle.addEventListener("click", async () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (panel.hidden || busy) return;
    setBusy(true);
    try {
      const result = await request("GET");
      if (result.expiresAt !== expiry) link = "";
      if (link && !(await fetch(`/api/share/${new URL(link).pathname.slice(7)}`, { method: "HEAD", cache: "no-store" })).ok) link = "";
      expiry = result.expiresAt;
      update();
    } catch (error) { showFeedback(() => localizedError(error)); }
    finally { setBusy(false); }
  });
  create.addEventListener("click", async () => {
    if (busy || (!link && expiry && !confirm(t("confirmRegenerate")))) return;
    setBusy(true);
    try {
      if (!link) {
        const result = await request("POST");
        link = new URL(result.url, location.origin).href;
        expiry = result.expiresAt;
        update();
      }
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(link);
        showFeedback(() => t("shareCopied"));
      } catch {
        input.focus(); input.select();
        const copied = document.execCommand("copy");
        showFeedback(() => t(copied ? "copied" : "manualCopy"));
      }
    } catch (error) { showFeedback(() => localizedError(error)); }
    finally { setBusy(false); }
  });
  revoke.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try { await request("DELETE"); expiry = null; link = ""; update(); showFeedback(() => t("shareRevoked")); }
    catch (error) { showFeedback(() => localizedError(error)); }
    finally { setBusy(false); }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); toggle.focus(); }
  });
}
