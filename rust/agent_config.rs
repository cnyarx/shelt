use super::*;
use serde_json::{json, Value};

pub const EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

pub fn input_box_text(screen: &str) -> Option<String> {
    let lines: Vec<&str> = screen.split('\n').collect();
    let bottom = lines.iter().rposition(|line| {
        let line = line.trim_end();
        (line.starts_with('╰') && line.ends_with('╯'))
            || (line.starts_with("────") && line.trim_matches('─').is_empty())
    })?;
    if lines[bottom].starts_with('─') {
        let top = lines.get(bottom.checked_sub(2)?)?.trim_end();
        let suffix = top.trim_start_matches('─');
        if !top.starts_with("───")
            || !(suffix.is_empty() || (suffix.starts_with(' ') && suffix.ends_with(" ──")))
        {
            return None;
        }
        let text = lines[bottom - 1].trim_end().strip_prefix(['>', '*'])?;
        if !text.is_empty() && !text.starts_with(' ') {
            return None;
        }
        let placeholder = text.strip_prefix("   ");
        if matches!(
            placeholder,
            Some(
                "Type your message or @path/to/file"
                    | "输入您的消息或 @ 文件路径"
                    | "Type your request, or /usage"
                    | "输入你的请求，或 /usage"
            )
        ) {
            return Some(String::new());
        }
        return Some(text.trim().to_string());
    }
    let top = lines[..bottom]
        .iter()
        .rposition(|line| line.trim_end().starts_with('╭') && line.trim_end().ends_with('╮'))?;
    let content: Vec<String> = lines[top + 1..bottom]
        .iter()
        .map(|line| {
            let trimmed = line.trim_end();
            let without_right = trimmed.strip_suffix('│').unwrap_or(trimmed);
            let without_left = without_right.strip_prefix('│').unwrap_or(without_right);
            let without_space = without_left.strip_prefix(' ').unwrap_or(without_left);
            without_space.trim_end().to_string()
        })
        .collect();
    Some(content.join("\n").trim().to_string())
}

const PROTOCOLS: &[&str] = &[
    "openai",
    "openai-responses",
    "anthropic",
    "gemini",
    "vertex-ai",
    "qwen-oauth",
    "qwen-subscription",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelChoice {
    provider: String,
    id: String,
    name: String,
    selector: String,
    multiple_routes: bool,
}

fn valid_model_id(id: &str) -> bool {
    (1..=120).contains(&id.len())
        && !id.starts_with("--")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
}

fn valid_model(model: &str) -> bool {
    if let Some((id, suffix)) = model.split_once('(') {
        return valid_model_id(id)
            && suffix
                .strip_suffix(')')
                .is_some_and(|protocol| PROTOCOLS.contains(&protocol));
    }
    valid_model_id(model)
}

async fn model_options() -> (Vec<ModelChoice>, String) {
    let path = PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".qwen/settings.json");
    let Ok(text) = tokio::fs::read_to_string(path).await else {
        return Default::default();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Default::default();
    };
    let providers = &value["modelProviders"];
    let groups: Vec<(&str, &Value)> = if let Some(groups) = providers.as_object() {
        groups
            .iter()
            .map(|(key, entries)| (key.as_str(), entries))
            .collect()
    } else {
        vec![("", providers)]
    };
    let mut choices: Vec<ModelChoice> = Vec::new();
    let mut declared = HashSet::new();
    for (provider, entries) in groups {
        let Some(entries) = entries.as_array() else {
            continue;
        };
        for entry in entries {
            let Some(id) = entry["id"].as_str().filter(|id| valid_model_id(id)) else {
                continue;
            };
            declared.insert(id);
            if [
                "imageOnly",
                "realtimeOnly",
                "fastOnly",
                "voiceOnly",
                "visionOnly",
            ]
            .iter()
            .any(|flag| entry[*flag].as_bool() == Some(true))
            {
                continue;
            }
            let mut protocol = value["providerProtocol"][provider]
                .as_str()
                .unwrap_or(provider);
            if let Some(wire) = entry.get("wireApi") {
                protocol = match (protocol, wire.as_str()) {
                    ("openai" | "openai-responses", Some("responses")) => "openai-responses",
                    ("openai" | "openai-responses", Some("chat-completions")) => "openai",
                    _ => continue,
                };
            }
            if !provider.is_empty() && !PROTOCOLS.contains(&protocol) {
                continue;
            }
            let selector = if protocol.is_empty() {
                id.to_string()
            } else {
                format!("{id}({protocol})")
            };
            if let Some(prior) = choices.iter_mut().find(|m| m.selector == selector) {
                prior.multiple_routes = true;
                prior.name = id.to_string();
                if prior.provider != provider {
                    prior.provider = protocol.to_string();
                }
            } else {
                choices.push(ModelChoice {
                    provider: provider.to_string(),
                    id: id.to_string(),
                    name: entry["name"]
                        .as_str()
                        .filter(|name| !name.is_empty())
                        .unwrap_or(id)
                        .to_string(),
                    selector,
                    multiple_routes: false,
                });
            }
        }
    }
    let default_model = value["model"]["name"].as_str().unwrap_or("");
    if valid_model(default_model)
        && !declared.contains(default_model)
        && !choices.iter().any(|m| m.selector == default_model)
    {
        choices.push(ModelChoice {
            provider: String::new(),
            id: default_model.to_string(),
            name: default_model.to_string(),
            selector: default_model.to_string(),
            multiple_routes: false,
        });
    }
    (choices, default_model.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRow {
    pane_id: String,
    title: String,
    status: String,
    workspace_id: String,
    workspace: String,
    input: Option<String>,
}

async fn qwen_agents(target: Option<&targets::HerdrTarget>) -> Vec<AgentRow> {
    let Some(result) = mobile::native_once(target, "session.snapshot", json!({})).await else {
        return Vec::new();
    };
    let snapshot = &result["snapshot"];
    let workspaces = snapshot["workspaces"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let tabs = snapshot["tabs"].as_array().cloned().unwrap_or_default();
    let mut agents = snapshot["agents"].as_array().cloned().unwrap_or_default();
    let workspace_index = |id: &str| {
        workspaces
            .iter()
            .position(|w| w["workspace_id"].as_str() == Some(id))
            .unwrap_or(workspaces.len())
    };
    let tab_index = |id: &str| {
        tabs.iter()
            .position(|t| t["tab_id"].as_str() == Some(id))
            .unwrap_or(tabs.len())
    };
    agents.sort_by_key(|a| {
        (
            workspace_index(a["workspace_id"].as_str().unwrap_or("")),
            tab_index(a["tab_id"].as_str().unwrap_or("")),
        )
    });
    let mut rows = Vec::new();
    for agent in agents {
        if agent["agent"].as_str() != Some("qwen") {
            continue;
        }
        let pane = agent["pane_id"].as_str().unwrap_or("").to_string();
        let workspace = workspaces
            .iter()
            .find(|w| w["workspace_id"] == agent["workspace_id"])
            .and_then(|w| w["label"].as_str())
            .filter(|label| !label.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| agent["workspace_id"].as_str().unwrap_or("").to_string());
        let tab = tabs
            .iter()
            .find(|t| t["tab_id"] == agent["tab_id"])
            .and_then(|t| t["label"].as_str())
            .filter(|label| !label.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| agent["tab_id"].as_str().unwrap_or("").to_string());
        let name = ["name", "terminal_title_stripped", "agent", "pane_id"]
            .iter()
            .filter_map(|key| agent[*key].as_str())
            .find(|value| !value.is_empty())
            .unwrap_or("")
            .to_string();
        let title = [workspace.as_str(), &tab, &name]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        let status = agent["agent_status"]
            .as_str()
            .filter(|status| !status.is_empty())
            .unwrap_or("unknown")
            .to_string();
        rows.push(AgentRow {
            pane_id: pane,
            title,
            status,
            workspace_id: agent["workspace_id"].as_str().unwrap_or("").to_string(),
            workspace,
            input: None,
        });
    }
    rows
}

fn active_target(state: &AppState) -> Option<targets::HerdrTarget> {
    let (active, targets) = state.targets.list();
    targets.into_iter().find(|target| target.id == active)
}

pub async fn options(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    if state.launch.mode != "herdr" {
        return secure((StatusCode::SERVICE_UNAVAILABLE, "Herdr unavailable").into_response());
    }
    let target = active_target(&state);
    let (choices, default_model) = model_options().await;
    let mut seen = HashSet::new();
    let models: Vec<_> = choices
        .iter()
        .map(|m| &m.id)
        .filter(|id| seen.insert(*id))
        .collect();
    let mut agents = qwen_agents(target.as_ref()).await;
    for agent in &mut agents {
        let read = mobile::native_once(
            target.as_ref(),
            "pane.read",
            json!({"pane_id": agent.pane_id, "source": "visible", "format": "text", "strip_ansi": true}),
        )
        .await;
        agent.input = read
            .and_then(|value| value["read"]["text"].as_str().map(str::to_string))
            .and_then(|text| input_box_text(&text));
    }
    let mut response = secure(
        Json(json!({"targetId": target.as_ref().map_or("local", |t| t.id.as_str()), "models": models, "modelChoices": choices, "defaultModel": default_model, "efforts": EFFORT_LEVELS, "agents": agents}))
            .into_response(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn apply(State(state): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    if state.launch.mode != "herdr" {
        return secure((StatusCode::SERVICE_UNAVAILABLE, "Herdr unavailable").into_response());
    }
    let Ok(value) = serde_json::from_str::<Value>(&body) else {
        return secure(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid_body"})),
            )
                .into_response(),
        );
    };
    let Some(panes) = value["panes"].as_array() else {
        return secure(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "panes_required"})),
            )
                .into_response(),
        );
    };
    if panes.is_empty() || panes.len() > 64 {
        return secure(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "panes_required"})),
            )
                .into_response(),
        );
    }
    let mut requested = Vec::new();
    for pane in panes {
        let Some(pane) = pane.as_str() else {
            return secure(
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": "invalid_pane"})),
                )
                    .into_response(),
            );
        };
        if !mobile::valid_pane(pane) {
            return secure(
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": "invalid_pane"})),
                )
                    .into_response(),
            );
        }
        requested.push(pane.to_string());
    }
    let model = value["model"].as_str().filter(|model| !model.is_empty());
    let effort = value["effort"].as_str().filter(|effort| !effort.is_empty());
    if let Some(model) = model {
        if !valid_model(model) {
            return secure(
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": "invalid_model"})),
                )
                    .into_response(),
            );
        }
    }
    if let Some(effort) = effort {
        if !EFFORT_LEVELS.contains(&effort) {
            return secure(
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": "invalid_effort"})),
                )
                    .into_response(),
            );
        }
    }
    if model.is_none() && effort.is_none() {
        return secure(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "nothing_to_apply"})),
            )
                .into_response(),
        );
    }
    if !value["model"].is_null() && model.is_none() {
        return secure(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid_model"})),
            )
                .into_response(),
        );
    }
    if !value["effort"].is_null() && effort.is_none() {
        return secure(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid_effort"})),
            )
                .into_response(),
        );
    }
    let target = active_target(&state);
    if value
        .get("targetId")
        .is_some_and(|id| id.as_str() != Some(target.as_ref().map_or("local", |t| t.id.as_str())))
    {
        return secure(
            (
                StatusCode::CONFLICT,
                Json(json!({"error": "target_changed"})),
            )
                .into_response(),
        );
    }
    let agents = qwen_agents(target.as_ref()).await;
    let mut results = Vec::new();
    for pane in requested {
        let Some(agent) = agents.iter().find(|agent| agent.pane_id == pane) else {
            results.push(
                json!({"paneId": pane, "title": pane, "ok": false, "reason": "agent_not_found"}),
            );
            continue;
        };
        let title = &agent.title;
        let status = agent.status.as_str();
        if status != "idle" && status != "done" {
            results.push(json!({"paneId": pane, "title": title, "ok": false, "reason": format!("status_{status}")}));
            continue;
        }
        let mut ok = true;
        let mut reason = "sent".to_string();
        if let Some(model) = model {
            let sent = mobile::native_once(
                target.as_ref(),
                "pane.send_input",
                json!({"pane_id": pane, "text": format!("/model {model}"), "keys": ["Enter"]}),
            )
            .await;
            if sent.is_none() {
                ok = false;
                reason = "send_failed".to_string();
            }
        }
        if ok {
            if let Some(effort) = effort {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let sent = mobile::native_once(
                    target.as_ref(),
                    "pane.send_input",
                    json!({"pane_id": pane, "text": format!("/effort {effort}"), "keys": ["Enter"]}),
                )
                .await;
                if sent.is_none() {
                    ok = false;
                    reason = "send_failed".to_string();
                }
            }
        }
        results.push(json!({"paneId": pane, "title": title, "ok": ok, "reason": reason}));
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    let mut response = secure(Json(json!({"results": results})).into_response());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
