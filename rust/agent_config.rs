use super::*;
use serde_json::{json, Value};

pub const EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

pub fn input_box_text(screen: &str) -> Option<String> {
    let lines: Vec<&str> = screen.split('\n').collect();
    let bottom = lines
        .iter()
        .rposition(|line| line.trim_end().starts_with('╰') && line.trim_end().ends_with('╯'))?;
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

pub async fn model_options() -> (Vec<String>, String) {
    let path = PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".qwen/settings.json");
    let Ok(text) = tokio::fs::read_to_string(path).await else {
        return (Vec::new(), String::new());
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return (Vec::new(), String::new());
    };
    let mut models: Vec<String> = Vec::new();
    if let Some(providers) = value["modelProviders"].as_array() {
        for provider in providers {
            if let Some(id) = provider["id"].as_str() {
                if !id.is_empty() && !models.iter().any(|model| model == id) {
                    models.push(id.to_string());
                }
            }
        }
    }
    let default_model = value["model"]["name"].as_str().unwrap_or("").to_string();
    if !default_model.is_empty() && !models.iter().any(|model| model == &default_model) {
        models.push(default_model.clone());
    }
    (models, default_model)
}

fn valid_model(model: &str) -> bool {
    (1..=120).contains(&model.len())
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

async fn qwen_agents(target: Option<&targets::HerdrTarget>) -> Vec<(String, String, String)> {
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
        let title = [workspace, tab, name]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        let status = agent["agent_status"]
            .as_str()
            .filter(|status| !status.is_empty())
            .unwrap_or("unknown")
            .to_string();
        rows.push((pane, title, status));
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
    let (models, default_model) = model_options().await;
    let mut agents = Vec::new();
    for (pane, title, status) in qwen_agents(target.as_ref()).await {
        let read = mobile::native_once(
            target.as_ref(),
            "pane.read",
            json!({"pane_id": pane, "source": "visible", "format": "text", "strip_ansi": true}),
        )
        .await;
        let input = read
            .and_then(|value| value["text"].as_str().map(str::to_string))
            .and_then(|text| input_box_text(&text));
        agents.push(json!({"paneId": pane, "title": title, "status": status, "input": input}));
    }
    let mut response = secure(
        Json(json!({"models": models, "defaultModel": default_model, "efforts": EFFORT_LEVELS, "agents": agents}))
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
    let agents = qwen_agents(target.as_ref()).await;
    let mut results = Vec::new();
    for pane in requested {
        let Some((_, title, status)) = agents.iter().find(|(id, _, _)| id == &pane) else {
            results.push(
                json!({"paneId": pane, "title": pane, "ok": false, "reason": "agent_not_found"}),
            );
            continue;
        };
        let title = title.clone();
        let status = status.clone();
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
