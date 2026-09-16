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
  const update = () => {
    create.textContent = link ? "复制分享链接" : expiry ? "重新生成并复制" : "创建并复制链接";
    setBusy(busy);
    status.textContent = expiry ? `有效期至 ${new Date(expiry * 1000).toLocaleString("zh-CN")}。${link ? "" : "旧链接无法找回，重新生成将使旧链接失效。"}` : "链接有效期为 7 天，持有链接的人无需登录即可查看此文档及其引用图片。";
    input.hidden = !link;
    input.value = link;
  };
  const request = async (method: string) => {
    const response = await fetch(api, { method, credentials: "same-origin" });
    if (!response.ok) throw new Error(response.status === 401 ? "请先在终端页面登录" : await response.text());
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
    } catch (error) { status.textContent = String(error); }
    finally { setBusy(false); }
  });
  create.addEventListener("click", async () => {
    if (busy || (!link && expiry && !confirm("重新生成将立即使旧分享链接失效，是否继续？"))) return;
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
        status.textContent = "分享链接已复制。请仅发送给可信任的人。";
      } catch {
        input.focus(); input.select();
        status.textContent = document.execCommand("copy") ? "分享链接已复制。" : "浏览器不允许自动复制，请复制下方已选中的链接。";
      }
    } catch (error) { status.textContent = String(error); }
    finally { setBusy(false); }
  });
  revoke.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try { await request("DELETE"); expiry = null; link = ""; update(); status.textContent = "分享已撤销，旧链接立即失效。"; }
    catch (error) { status.textContent = String(error); }
    finally { setBusy(false); }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); toggle.focus(); }
  });
}
