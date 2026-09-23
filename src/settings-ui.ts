import { HTML_INTERACTIVE_KEY, htmlInteractiveEnabled, setHtmlInteractive } from "./preview-preferences.ts";

type HerdrTarget = { id: string; name: string; remote: string; session: string | null };
type TargetsResponse = { mode: string; active: string; targets: HerdrTarget[] };

const LOCAL_ID = "local";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Shelt settings UI mount missing: ${id}`);
  return found as T;
}

export function setupSettings(options: { setSwitching: (value: boolean) => void }): void {
  const toggle = element<HTMLButtonElement>("settings-toggle");
  const panel = element("settings-panel");
  const herdrSection = element("settings-herdr");
  const list = element("target-list");
  const form = element<HTMLFormElement>("target-form");
  const nameInput = element<HTMLInputElement>("target-name");
  const remoteInput = element<HTMLInputElement>("target-remote");
  const sessionInput = element<HTMLInputElement>("target-session");
  const submit = element<HTMLButtonElement>("target-submit");
  const cancel = element<HTMLButtonElement>("target-cancel");
  const status = element("settings-status");
  const version = element("settings-version");
  const interactivePreview = element<HTMLInputElement>("html-interactive");
  interactivePreview.checked = htmlInteractiveEnabled();
  interactivePreview.addEventListener("change", () => {
    try {
      setHtmlInteractive(interactivePreview.checked);
      status.textContent = interactivePreview.checked ? "已开启 HTML 交互预览。" : "已切换为静态安全预览。";
    } catch {
      interactivePreview.checked = htmlInteractiveEnabled();
      status.textContent = "浏览器不允许保存设置，请检查存储权限。";
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === HTML_INTERACTIVE_KEY || event.key === null) interactivePreview.checked = htmlInteractiveEnabled();
  });
  const passwordForm = element<HTMLFormElement>("password-form");
  const currentPassword = element<HTMLInputElement>("current-password");
  const newPassword = element<HTMLInputElement>("new-password");
  const confirmPassword = element<HTMLInputElement>("confirm-new-password");
  const passwordSubmit = element<HTMLButtonElement>("password-submit");
  let state: TargetsResponse = { mode: "shell", active: LOCAL_ID, targets: [] };
  let editing: string | null = null;
  let busy = false;

  const request = async (url: string, method: string, body?: unknown) => {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {}
      throw new Error(message || `请求失败（${response.status}）`);
    }
    return response.json();
  };

  const resetForm = () => {
    editing = null;
    form.reset();
    submit.textContent = "添加";
    cancel.hidden = true;
  };

  const render = () => {
    herdrSection.hidden = state.mode !== "herdr";
    list.replaceChildren();
    const rows: { id: string; name: string; detail: string; removable: boolean }[] = [
      { id: LOCAL_ID, name: "本机 Herdr", detail: "默认连接", removable: false },
      ...state.targets.map((target) => ({
        id: target.id,
        name: target.name,
        detail: target.session ? `${target.remote} · 会话 ${target.session}` : target.remote,
        removable: true,
      })),
    ];
    for (const row of rows) {
      const item = document.createElement("li");
      item.className = `target-row${row.id === state.active ? " active" : ""}`;
      item.title = row.id === state.active ? "当前连接" : "点击切换到此连接";
      const main = document.createElement("span");
      main.className = "target-main";
      const name = document.createElement("span");
      name.className = "target-name";
      name.textContent = row.name;
      const detail = document.createElement("span");
      detail.className = "target-detail";
      detail.textContent = row.detail;
      main.append(name, detail);
      item.append(main);
      if (row.removable) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "target-action";
        edit.textContent = "编辑";
        edit.addEventListener("click", (event) => {
          event.stopPropagation();
          const target = state.targets.find((candidate) => candidate.id === row.id);
          if (!target) return;
          editing = target.id;
          nameInput.value = target.name;
          remoteInput.value = target.remote;
          sessionInput.value = target.session ?? "";
          submit.textContent = "保存";
          cancel.hidden = false;
          nameInput.focus();
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "target-action";
        remove.textContent = "删除";
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          if (busy || !confirm(`删除连接“${row.name}”？`)) return;
          busy = true;
          void request(`/api/herdr/targets/${row.id}`, "DELETE")
            .then(() => {
              if (editing === row.id) resetForm();
              status.textContent = "已删除。";
              return refresh();
            })
            .catch((error) => { status.textContent = String(error instanceof Error ? error.message : error); })
            .finally(() => { busy = false; });
        });
        item.append(edit, remove);
      }
      item.addEventListener("click", () => {
        if (busy || row.id === state.active) return;
        busy = true;
        options.setSwitching(true);
        status.textContent = "正在切换连接…";
        void request("/api/herdr/active", "POST", { id: row.id })
          .then(() => {
            state.active = row.id;
            render();
            panel.hidden = true;
            toggle.setAttribute("aria-expanded", "false");
          })
          .catch((error) => {
            options.setSwitching(false);
            status.textContent = String(error instanceof Error ? error.message : error);
          })
          .finally(() => { busy = false; });
      });
      list.append(item);
    }
  };

  const refresh = async () => {
    state = await request("/api/herdr/targets", "GET") as TargetsResponse;
    render();
  };

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (panel.hidden) return;
    status.textContent = "";
    version.textContent = "正在读取版本…";
    void request("/api/version", "GET")
      .then((result: { version: string; commit: string; dirty: boolean }) => {
        if (!panel.hidden) version.textContent = `Shelt ${result.version} · ${result.commit}${result.dirty ? " · 未提交改动" : ""}`;
      })
      .catch(() => { if (!panel.hidden) version.textContent = "版本信息不可用"; });
    void refresh().catch((error) => { status.textContent = String(error instanceof Error ? error.message : error); });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    const body = {
      name: nameInput.value,
      remote: remoteInput.value.trim(),
      session: sessionInput.value.trim() || null,
    };
    busy = true;
    submit.disabled = true;
    void request(editing ? `/api/herdr/targets/${editing}` : "/api/herdr/targets", editing ? "PUT" : "POST", body)
      .then(() => {
        status.textContent = editing ? "已保存。" : "已添加。";
        resetForm();
        return refresh();
      })
      .catch((error) => { status.textContent = String(error instanceof Error ? error.message : error); })
      .finally(() => { busy = false; submit.disabled = false; });
  });

  cancel.addEventListener("click", () => resetForm());

  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    if (newPassword.value !== confirmPassword.value) {
      status.textContent = "两次输入的新密码不一致。";
      confirmPassword.select();
      return;
    }
    busy = true;
    passwordSubmit.disabled = true;
    void request("/api/auth/password", "POST", { currentPassword: currentPassword.value, newPassword: newPassword.value })
      .then(() => {
        status.textContent = "密码已修改，其他浏览器的登录状态已失效。";
        passwordForm.reset();
      })
      .catch((error) => { status.textContent = String(error instanceof Error ? error.message : error); })
      .finally(() => { busy = false; passwordSubmit.disabled = false; });
  });

  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (panel.hidden || panel.contains(event.target as Node) || toggle.contains(event.target as Node)) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  });
}

export function setSettingsVisible(visible: boolean): void {
  element("settings-toggle").hidden = !visible;
  if (!visible) {
    element("settings-panel").hidden = true;
    element("settings-toggle").setAttribute("aria-expanded", "false");
  }
}
