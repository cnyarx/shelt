import { HTML_INTERACTIVE_KEY, htmlInteractiveEnabled, setHtmlInteractive } from "./preview-preferences.ts";
import { localizedError, onLanguageChange, setupLanguage, t } from "./i18n.ts";

type HerdrTarget = { id: string; name: string; remote: string; session: string | null };
type TargetsResponse = { mode: string; active: string; targets: HerdrTarget[] };
type BuildVersion = { version: string; commit: string; dirty: boolean };

const LOCAL_ID = "local";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Shelt settings UI mount missing: ${id}`);
  return found as T;
}

export function setupSettings(options: { setSwitching: (value: boolean) => void }): void {
  setupLanguage();
  const toggle = element<HTMLButtonElement>("settings-toggle");
  const panel = element("settings-panel");
  const herdrSection = element("settings-herdr");
  const list = element("target-list");
  const add = element<HTMLButtonElement>("target-add");
  const form = element<HTMLFormElement>("target-form");
  const nameInput = element<HTMLInputElement>("target-name");
  const remoteInput = element<HTMLInputElement>("target-remote");
  const sessionInput = element<HTMLInputElement>("target-session");
  const submit = element<HTMLButtonElement>("target-submit");
  const cancel = element<HTMLButtonElement>("target-cancel");
  const status = element("settings-status");
  const version = element("settings-version");
  const interactivePreview = element<HTMLInputElement>("html-interactive");
  const passwordToggle = element<HTMLButtonElement>("password-toggle");
  const passwordForm = element<HTMLFormElement>("password-form");
  const currentPassword = element<HTMLInputElement>("current-password");
  const newPassword = element<HTMLInputElement>("new-password");
  const confirmPassword = element<HTMLInputElement>("confirm-new-password");
  const passwordSubmit = element<HTMLButtonElement>("password-submit");
  const passwordCancel = element<HTMLButtonElement>("password-cancel");
  let state: TargetsResponse = { mode: "shell", active: LOCAL_ID, targets: [] };
  let editing: string | null = null;
  let busy = false;
  let statusText = () => "";
  let versionText = () => "";
  const showStatus = (message: () => string) => { statusText = message; status.textContent = message(); };
  const showError = (error: unknown) => showStatus(() => localizedError(error));

  interactivePreview.checked = htmlInteractiveEnabled();
  interactivePreview.addEventListener("change", () => {
    try {
      setHtmlInteractive(interactivePreview.checked);
      const enabled = interactivePreview.checked;
      showStatus(() => t(enabled ? "interactiveOn" : "interactiveOff"));
    } catch {
      interactivePreview.checked = htmlInteractiveEnabled();
      showStatus(() => t("storageError"));
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === HTML_INTERACTIVE_KEY || event.key === null) interactivePreview.checked = htmlInteractiveEnabled();
  });

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
      throw new Error(message || t("requestFailed", { status: response.status }));
    }
    return response.json();
  };

  const resetForm = () => {
    editing = null;
    form.reset();
    form.hidden = true;
    add.setAttribute("aria-expanded", "false");
    submit.textContent = t("add");
  };
  const closePassword = () => {
    passwordForm.reset();
    passwordForm.hidden = true;
    passwordToggle.setAttribute("aria-expanded", "false");
  };
  const closePanel = () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    closePassword();
    resetForm();
  };
  const openForm = (target?: HerdrTarget) => {
    closePassword();
    resetForm();
    if (target) {
      editing = target.id;
      nameInput.value = target.name;
      remoteInput.value = target.remote;
      sessionInput.value = target.session ?? "";
    }
    submit.textContent = t(editing ? "save" : "add");
    form.hidden = false;
    add.setAttribute("aria-expanded", "true");
    nameInput.focus();
  };
  resetForm();
  closePassword();

  const render = () => {
    herdrSection.hidden = state.mode !== "herdr";
    list.replaceChildren();
    const rows: { id: string; name: string; detail: string; removable: boolean }[] = [
      { id: LOCAL_ID, name: t("localHerdr"), detail: t("defaultConnection"), removable: false },
      ...state.targets.map((target) => ({
        id: target.id,
        name: target.name,
        detail: target.session ? `${target.remote} · ${t("sessionDetail", { name: target.session })}` : target.remote,
        removable: true,
      })),
    ];
    for (const row of rows) {
      const item = document.createElement("li");
      item.className = `target-row${row.id === state.active ? " active" : ""}`;
      item.title = t(row.id === state.active ? "currentConnection" : "switchConnection");
      const main = document.createElement("button");
      main.type = "button";
      main.className = "target-main";
      main.setAttribute("aria-current", String(row.id === state.active));
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
        edit.textContent = t("edit");
        edit.addEventListener("click", (event) => {
          event.stopPropagation();
          if (busy) return;
          const target = state.targets.find((candidate) => candidate.id === row.id);
          if (target) openForm(target);
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "target-action";
        remove.textContent = t("remove");
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          if (busy || !confirm(t("removeConnection", { name: row.name }))) return;
          busy = true;
          void request(`/api/herdr/targets/${row.id}`, "DELETE")
            .then(() => {
              if (editing === row.id) resetForm();
              showStatus(() => t("removed"));
              return refresh();
            })
            .catch(showError)
            .finally(() => { busy = false; });
        });
        item.append(edit, remove);
      }
      main.addEventListener("click", () => {
        if (busy || row.id === state.active) return;
        busy = true;
        options.setSwitching(true);
        showStatus(() => t("switching"));
        void request("/api/herdr/active", "POST", { id: row.id })
          .then(() => {
            state.active = row.id;
            render();
            closePanel();
          })
          .catch((error) => { options.setSwitching(false); showError(error); })
          .finally(() => { busy = false; });
      });
      list.append(item);
    }
  };

  const refresh = async () => {
    state = await request("/api/herdr/targets", "GET") as TargetsResponse;
    render();
  };
  onLanguageChange(() => {
    render();
    submit.textContent = t(editing ? "save" : "add");
    status.textContent = statusText();
    version.textContent = versionText();
  });

  toggle.addEventListener("click", () => {
    if (!panel.hidden) { closePanel(); return; }
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    showStatus(() => "");
    versionText = () => t("loadingVersion");
    version.textContent = versionText();
    void request("/api/version", "GET")
      .then((result: BuildVersion) => {
        versionText = () => `Shelt ${result.version === "开发版" ? t("development") : result.version} · ${result.commit}${result.dirty ? ` · ${t("dirty")}` : ""}`;
        if (!panel.hidden) version.textContent = versionText();
      })
      .catch(() => { versionText = () => t("unavailableVersion"); if (!panel.hidden) version.textContent = versionText(); });
    void refresh().catch(showError);
  });
  add.addEventListener("click", () => {
    if (busy) return;
    if (!form.hidden && !editing) { resetForm(); return; }
    openForm();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    const body = { name: nameInput.value, remote: remoteInput.value.trim(), session: sessionInput.value.trim() || null };
    busy = true;
    submit.disabled = true;
    const wasEditing = editing !== null;
    void request(editing ? `/api/herdr/targets/${editing}` : "/api/herdr/targets", editing ? "PUT" : "POST", body)
      .then(() => {
        showStatus(() => t(wasEditing ? "saved" : "added"));
        resetForm();
        add.focus();
        return refresh();
      })
      .catch(showError)
      .finally(() => { busy = false; submit.disabled = false; });
  });
  cancel.addEventListener("click", () => { if (!busy) { resetForm(); add.focus(); } });
  passwordToggle.addEventListener("click", () => {
    if (busy) return;
    if (!passwordForm.hidden) { closePassword(); return; }
    resetForm();
    passwordForm.hidden = false;
    passwordToggle.setAttribute("aria-expanded", "true");
    currentPassword.focus();
  });
  passwordCancel.addEventListener("click", () => { if (!busy) { closePassword(); passwordToggle.focus(); } });
  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    if (newPassword.value !== confirmPassword.value) {
      showStatus(() => t("passwordMismatch"));
      confirmPassword.select();
      return;
    }
    busy = true;
    passwordSubmit.disabled = true;
    void request("/api/auth/password", "POST", { currentPassword: currentPassword.value, newPassword: newPassword.value })
      .then(() => { showStatus(() => t("passwordChanged")); closePassword(); passwordToggle.focus(); })
      .catch(showError)
      .finally(() => { busy = false; passwordSubmit.disabled = false; });
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closePanel(); toggle.focus(); }
  });
  document.addEventListener("click", (event) => {
    if (panel.hidden || panel.contains(event.target as Node) || toggle.contains(event.target as Node)) return;
    closePanel();
  });
}

export function setSettingsVisible(visible: boolean): void {
  element("settings-toggle").hidden = !visible;
  if (!visible) {
    element("settings-panel").hidden = true;
    element("settings-toggle").setAttribute("aria-expanded", "false");
  }
}
