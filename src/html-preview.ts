import { HTML_INTERACTIVE_KEY, htmlInteractiveEnabled } from "./preview-preferences.ts";
import type { PreviewTtsController } from "./tts.ts";

export async function mountHtmlPreview(mount: HTMLElement, path: string, apiUrl: string, tts: PreviewTtsController | null): Promise<void> {
  let generation = 0;
  let grant: string | null = null;
  const revoke = (token: string) => fetch(`/api/preview-session/${token}`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => {});
  const render = async () => {
    const current = ++generation;
    const previous = grant;
    grant = null;
    mount.replaceChildren();
    tts?.setDocument(null, undefined, "正在加载预览…");
    if (previous) await revoke(previous);
    const interactive = htmlInteractiveEnabled();
    let url = apiUrl;
    if (interactive) {
      const response = await fetch("/api/preview-session", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
      });
      if (!response.ok) {
        if (current === generation) mount.textContent = response.status === 401 ? "请先在终端页面登录，再刷新预览。" : "无法打开交互预览。请检查文件是否在允许的目录中，或在设置中关闭 HTML 交互预览。";
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
    frame.title = path.split("/").pop() || "HTML 预览";
    if (interactive) {
      tts?.setDocument(null, undefined, "交互模式不支持朗读；可在设置中关闭 HTML 交互预览后朗读。");
    } else {
      frame.addEventListener("load", () => {
        if (current !== generation) return;
        try { tts?.setDocument(frame.contentDocument, frame); }
        catch { tts?.setDocument(null, undefined, "此预览没有可朗读内容"); }
      });
    }
    frame.src = url;
    mount.replaceChildren(frame);
  };
  window.addEventListener("storage", (event) => {
    if (event.key === HTML_INTERACTIVE_KEY || event.key === null) void render().catch(() => { mount.textContent = "无法切换预览模式，请刷新后重试。"; });
  });
  window.addEventListener("pagehide", () => {
    generation += 1;
    if (grant) { void revoke(grant); grant = null; }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void render().catch(() => { mount.textContent = "无法恢复预览，请刷新后重试。"; });
  });
  await render();
}
