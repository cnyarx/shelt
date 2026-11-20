import { agentNotificationsSupported, requestAgentNotificationPermission, syncAgentNotifications } from "./agent-notifications.ts";
import { HTML_INTERACTIVE_KEY, htmlInteractiveEnabled, setHtmlInteractive } from "./preview-preferences.ts";
import {
  NOTIFY_BLOCKED_KEY,
  NOTIFY_DONE_KEY,
  notifyBlockedEnabled,
  notifyDoneEnabled,
  setNotifyBlocked,
  setNotifyDone,
} from "./notify-preferences.ts";
import { localizedError, onLanguageChange, setupLanguage, t } from "./i18n.ts";
import type { AgentConfigOptions, AgentConfigResult, AgentConfigRow, ModelChoice } from "./agent-config.ts";

type HerdrTarget = { id: string; name: string; remote: string; session: string | null };
type TargetsResponse = { mode: string; active: string; targets: HerdrTarget[] };
type BuildVersion = { version: string; commit: string; dirty: boolean };

const LOCAL_ID = "local";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Shelt settings UI mount missing: ${id}`);
  return found as T;
}

export function setupSettings(options: { setSwitching: (value: boolean) => void; checkUpdates?: () => void }): void {
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
  const notifyDoneInput = element<HTMLInputElement>("notify-done");
  const notifyBlockedInput = element<HTMLInputElement>("notify-blocked");
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
    if (event.key === NOTIFY_DONE_KEY || event.key === null) notifyDoneInput.checked = notifyDoneEnabled();
    if (event.key === NOTIFY_BLOCKED_KEY || event.key === null) notifyBlockedInput.checked = notifyBlockedEnabled();
  });

  notifyDoneInput.checked = notifyDoneEnabled();
  notifyBlockedInput.checked = notifyBlockedEnabled();
  const applyNotifyToggle = async (input: HTMLInputElement, persist: (value: boolean) => void) => {
    try {
      persist(input.checked);
      syncAgentNotifications();
      if (!input.checked) {
        showStatus(() => t("notifyOff"));
        return;
      }
      if (!agentNotificationsSupported()) {
        showStatus(() => t("notifyUnavailable"));
        return;
      }
      const permission = await requestAgentNotificationPermission();
      if (permission === "granted") showStatus(() => t("notifyOn"));
      else if (permission === "denied") showStatus(() => t("notifyPermissionDenied"));
      else showStatus(() => t("notifyPermissionPending"));
    } catch {
      showStatus(() => t("storageError"));
    }
  };
  notifyDoneInput.addEventListener("change", () => { void applyNotifyToggle(notifyDoneInput, setNotifyDone); });
  notifyBlockedInput.addEventListener("change", () => { void applyNotifyToggle(notifyBlockedInput, setNotifyBlocked); });

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

  const agentSection = element("settings-agents");
  const agentModel = element<HTMLSelectElement>("agent-model");
  const agentEffort = element<HTMLSelectElement>("agent-effort");
  const agentList = element("agent-config-list");
  const agentResults = element("agent-config-results");
  const agentApply = element<HTMLButtonElement>("agent-config-apply");
  const agentRefresh = element<HTMLButtonElement>("agent-config-refresh");
  const selectable = (a: AgentConfigRow) => (a.status === "idle" || a.status === "done") && a.input === "";
  let agentOptions: AgentConfigOptions | null = null;
  let agentResultRows: AgentConfigResult[] = [];
  let agentBusy = false;
  const checkedPanes = new Set<string>();
  const reasonText = (reason: string) => {
    if (reason === "sent") return t("reasonSent");
    if (reason === "agent_not_found") return t("reasonNotFound");
    if (reason === "not_qwen") return t("reasonNotQwen");
    if (reason === "send_failed") return t("reasonSendFailed");
    if (reason.startsWith("status_")) return t("reasonStatus") + reason.slice(7);
    return reason;
  };
  const fillModels = (choices: ModelChoice[]) => {
    const current = agentModel.value;
    const keep = document.createElement("option");
    keep.value = "";
    keep.textContent = t("agentNoChange");
    agentModel.replaceChildren(keep);
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const choice of choices) {
      let group = groups.get(choice.provider);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = choice.provider || t("agentOtherModels");
        groups.set(choice.provider, group);
        agentModel.append(group);
      }
      const option = document.createElement("option");
      option.value = choice.selector;
      const label = choice.name === choice.id ? choice.id : `${choice.name} — ${choice.id}`;
      option.textContent = choice.multipleRoutes ? `${label} · ${t("agentDefaultRoute")}` : label;
      group.append(option);
    }
    agentModel.value = choices.some(choice => choice.selector === current) ? current : "";
  };
  const fillSelect = (select: HTMLSelectElement, values: string[]) => {
    const current = select.value;
    select.replaceChildren();
    const keep = document.createElement("option");
    keep.value = "";
    keep.textContent = t("agentNoChange");
    select.append(keep);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.value = values.includes(current) ? current : "";
  };
  const renderAgents = () => {
    if (!agentOptions) return;
    fillModels(agentOptions.modelChoices);
    fillSelect(agentEffort, agentOptions.efforts);
    agentList.replaceChildren();
    if (!agentOptions.agents.length) {
      const empty = document.createElement("li");
      empty.className = "agent-config-empty";
      empty.textContent = t("agentConfigNone");
      agentList.append(empty);
    }
    const boxes = new Map<string, HTMLInputElement>();
    const updateCounts: (() => void)[] = [];
    const sync = () => {
      for (const [id, box] of boxes) box.checked = checkedPanes.has(id);
      for (const update of updateCounts) update();
    };
    const selectGroup = (agents: AgentConfigRow[], name: string) => {
      const eligible = agents.filter(selectable);
      const label = document.createElement("label");
      label.className = "agent-config-group-heading";
      const box = document.createElement("input");
      box.type = "checkbox";
      const caption = document.createElement("span");
      label.append(box, caption);
      updateCounts.push(() => {
        const count = eligible.filter(a => checkedPanes.has(a.paneId)).length;
        box.disabled = eligible.length === 0;
        box.checked = count > 0 && count === eligible.length;
        box.indeterminate = count > 0 && count < eligible.length;
        caption.textContent = `${name} (${count}/${eligible.length})`;
      });
      box.addEventListener("change", () => {
        for (const a of agents) {
          if (box.checked && selectable(a)) checkedPanes.add(a.paneId);
          else checkedPanes.delete(a.paneId);
        }
        sync();
      });
      return label;
    };
    const spaces = new Map<string, AgentConfigRow[]>();
    for (const agent of agentOptions.agents) {
      const rows = spaces.get(agent.workspaceId);
      if (rows) rows.push(agent);
      else spaces.set(agent.workspaceId, [agent]);
    }
    if (spaces.size) {
      const all = document.createElement("li");
      all.append(selectGroup(agentOptions.agents, t("agentSelectAll")));
      agentList.append(all);
    }
    const spaceNames = [...spaces.values()].map(rows => rows[0]!.workspace);
    for (const [spaceId, agents] of spaces) {
      const group = document.createElement("li");
      group.dataset.workspace = spaceId;
      const rows = document.createElement("ul");
      rows.className = "agent-config-list";
      const name = agents[0]!.workspace;
      const heading = spaceNames.indexOf(name) === spaceNames.lastIndexOf(name) ? name : `${name} · ${spaceId}`;
      group.append(selectGroup(agents, heading), rows);
      agentList.append(group);
      for (const agent of agents) {
        const item = document.createElement("li");
        item.className = "agent-config-row";
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.pane = agent.paneId;
        box.disabled = agent.status !== "idle" && agent.status !== "done";
        boxes.set(agent.paneId, box);
        box.addEventListener("change", () => {
          if (box.checked) checkedPanes.add(agent.paneId);
          else checkedPanes.delete(agent.paneId);
          sync();
        });
        const title = document.createElement("span");
        title.className = "agent-config-title";
        title.textContent = agent.title;
        const state = document.createElement("span");
        state.className = "agent-config-status";
        state.textContent = agent.status;
        const input = document.createElement("span");
        input.className = "agent-config-input";
        input.textContent = agent.input === null ? t("agentInputUnknown") : agent.input === "" ? t("agentInputEmpty") : agent.input;
        label.append(box, title, state);
        item.append(label, input);
        rows.append(item);
      }
    }
    sync();
    agentResults.replaceChildren();
    for (const row of agentResultRows) {
      const item = document.createElement("li");
      item.className = `agent-config-result${row.ok ? " ok" : " skipped"}`;
      item.textContent = `${row.title} — ${reasonText(row.reason)}`;
      agentResults.append(item);
    }
  };
  const loadAgents = async () => {
    const loaded = await request("/api/agent-config/options", "GET") as AgentConfigOptions;
    agentOptions = loaded;
    checkedPanes.clear();
    for (const agent of loaded.agents) {
      if (selectable(agent)) checkedPanes.add(agent.paneId);
    }
    renderAgents();
  };
  agentRefresh.addEventListener("click", () => { if (!agentBusy) void loadAgents().catch(showError); });
  agentApply.addEventListener("click", () => {
    if (agentBusy) return;
    const panes = [...checkedPanes];
    const model = agentModel.value;
    const effort = agentEffort.value;
    if (!panes.length || (!model && !effort)) { showStatus(() => t("agentSelectNothing")); return; }
    agentBusy = true;
    agentApply.disabled = true;
    const targetId = agentOptions?.targetId;
    agentResultRows = [];
    void (async () => {
      // Keep each request within the existing 64-pane and 8 KiB API limits.
      for (let i = 0; i < panes.length; i += 48) {
        const result = await request("/api/agent-config/apply", "POST", { targetId, panes: panes.slice(i, i + 48), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        agentResultRows.push(...result.results);
        renderAgents();
      }
      showStatus(() => t("agentConfigDone"));
    })()
      .catch(showError)
      .finally(() => { agentBusy = false; agentApply.disabled = false; });
  });

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
    agentSection.hidden = state.mode !== "herdr";
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
    if (state.mode === "herdr") await loadAgents();
  };
  onLanguageChange(() => {
    render();
    renderAgents();
    submit.textContent = t(editing ? "save" : "add");
    status.textContent = statusText();
    version.textContent = versionText();
  });

  toggle.addEventListener("click", () => {
    if (!panel.hidden) { closePanel(); return; }
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    options.checkUpdates?.();
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
