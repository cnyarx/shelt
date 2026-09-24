use super::*;
use futures_util::stream::{once, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::broadcast;

#[derive(Clone, serde::Serialize)]
struct AgentInfo {
    #[serde(rename = "paneId")]
    pane_id: String,
    status: String,
    title: String,
    agent: String,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum BridgeMessage {
    #[serde(rename_all = "camelCase")]
    Snapshot { agents: Vec<AgentInfo> },
    #[serde(rename_all = "camelCase")]
    Status {
        pane_id: String,
        status: String,
        title: String,
        agent: String,
    },
    #[serde(rename_all = "camelCase")]
    Removed { pane_id: String },
}

struct Inner {
    socket_path: PathBuf,
    agents: RwLock<HashMap<String, AgentInfo>>,
    tx: broadcast::Sender<String>,
    started: Mutex<bool>,
    retry_delay_ms: AtomicU64,
}

/// Event-stream bridge to the local Herdr server socket. Purely event driven:
/// one persistent connection subscribes to agent status changes, no polling.
#[derive(Clone)]
pub struct HerdrEvents(Arc<Inner>);

impl HerdrEvents {
    pub fn new(socket_path: PathBuf) -> Self {
        let (tx, _) = broadcast::channel(64);
        HerdrEvents(Arc::new(Inner {
            socket_path,
            agents: RwLock::new(HashMap::new()),
            tx,
            started: Mutex::new(false),
            retry_delay_ms: AtomicU64::new(1000),
        }))
    }

    /// Returns the current snapshot JSON plus a receiver for future updates.
    pub fn subscribe(&self) -> (String, broadcast::Receiver<String>) {
        {
            let mut started = self.0.started.lock().unwrap();
            if !*started {
                *started = true;
                let inner = Arc::clone(&self.0);
                tokio::spawn(async move { run_bridge(inner).await });
            }
        }
        let snapshot = serde_json::to_string(&BridgeMessage::Snapshot {
            agents: self.snapshot(),
        })
        .unwrap();
        (snapshot, self.0.tx.subscribe())
    }

    fn snapshot(&self) -> Vec<AgentInfo> {
        self.0.agents.read().unwrap().values().cloned().collect()
    }

    fn broadcast(&self, message: &BridgeMessage) {
        let _ = self.0.tx.send(serde_json::to_string(message).unwrap());
    }

    fn store(&self, agents: Vec<AgentInfo>) {
        *self.0.agents.write().unwrap() = agents
            .into_iter()
            .map(|agent| (agent.pane_id.clone(), agent))
            .collect::<HashMap<_, _>>();
    }

    fn apply_status(
        &self,
        pane_id: &str,
        status: &str,
        agent: Option<&str>,
    ) -> Option<BridgeMessage> {
        let mut agents = self.0.agents.write().unwrap();
        let previous = agents.get(pane_id).cloned();
        let title = previous
            .as_ref()
            .map(|info| info.title.clone())
            .unwrap_or_else(|| agent.unwrap_or(pane_id).to_string());
        let agent_name = agent
            .map(str::to_string)
            .or_else(|| previous.as_ref().map(|info| info.agent.clone()))
            .unwrap_or_default();
        let cwd = previous.map(|info| info.cwd).unwrap_or_default();
        agents.insert(
            pane_id.to_string(),
            AgentInfo {
                pane_id: pane_id.to_string(),
                status: status.to_string(),
                title: title.clone(),
                agent: agent_name.clone(),
                cwd,
            },
        );
        Some(BridgeMessage::Status {
            pane_id: pane_id.to_string(),
            status: status.to_string(),
            title,
            agent: agent_name,
        })
    }

    fn remove(&self, pane_id: &str) -> Option<BridgeMessage> {
        if self.0.agents.write().unwrap().remove(pane_id).is_some() {
            Some(BridgeMessage::Removed {
                pane_id: pane_id.to_string(),
            })
        } else {
            None
        }
    }
}

async fn run_bridge(inner: Arc<Inner>) {
    let bridge = HerdrEvents(Arc::clone(&inner));
    loop {
        let failed = run_connection(&inner, &bridge).await.is_err();
        if failed {
            let delay_ms = inner.retry_delay_ms.load(Ordering::SeqCst);
            inner
                .retry_delay_ms
                .store((delay_ms * 2).clamp(1, 30_000), Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        } else {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

async fn write_request(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    id: &str,
    method: &str,
    params: &str,
) -> std::io::Result<()> {
    writer
        .write_all(
            format!("{{\"id\":\"{id}\",\"method\":\"{method}\",\"params\":{params}}}\n").as_bytes(),
        )
        .await
}

/// Sends a request and reads lines until the matching response arrives.
async fn request(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
    id: &str,
    method: &str,
    params: &str,
) -> Result<serde_json::Value, String> {
    write_request(writer, id, method, params)
        .await
        .map_err(|e| e.to_string())?;
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("socket closed".to_string());
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if value.get("id").and_then(|found| found.as_str()) == Some(id) {
            return Ok(value
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null));
        }
    }
}

fn parse_agents(result: &serde_json::Value) -> Vec<AgentInfo> {
    result
        .get("agents")
        .and_then(|agents| agents.as_array())
        .map(|agents| {
            agents
                .iter()
                .filter_map(|agent| {
                    let pane_id = agent.get("pane_id")?.as_str()?.to_string();
                    let status = agent.get("agent_status")?.as_str()?.to_string();
                    let agent_name = agent.get("agent").and_then(|v| v.as_str()).unwrap_or("");
                    let title = agent
                        .get("terminal_title_stripped")
                        .and_then(|v| v.as_str())
                        .filter(|title| !title.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            if agent_name.is_empty() {
                                pane_id.clone()
                            } else {
                                agent_name.to_string()
                            }
                        });
                    Some(AgentInfo {
                        pane_id: pane_id.clone(),
                        status,
                        title,
                        agent: agent_name.to_string(),
                        cwd: agent
                            .get("cwd")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn subscribe_params(pane_ids: &[String]) -> String {
    let mut subscriptions = vec![
        serde_json::json!({"type": "pane.agent_detected"}),
        serde_json::json!({"type": "pane.closed"}),
    ];
    for pane_id in pane_ids {
        subscriptions
            .push(serde_json::json!({"type": "pane.agent_status_changed", "pane_id": pane_id}));
    }
    serde_json::json!({"subscriptions": subscriptions}).to_string()
}

async fn run_connection(inner: &Arc<Inner>, bridge: &HerdrEvents) -> Result<(), String> {
    let stream = UnixStream::connect(&inner.socket_path)
        .await
        .map_err(|e| e.to_string())?;
    let (read_half, mut writer) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    // The Herdr server only serves queries after a ping handshake.
    request(&mut writer, &mut reader, "shelt:ping", "ping", "{}").await?;
    let list = request(&mut writer, &mut reader, "shelt:agents", "agent.list", "{}").await?;
    let agents = parse_agents(&list);
    let pane_ids = agents
        .iter()
        .map(|agent| agent.pane_id.clone())
        .collect::<Vec<_>>();
    let params = subscribe_params(&pane_ids);
    request(
        &mut writer,
        &mut reader,
        "shelt:subscribe",
        "events.subscribe",
        &params,
    )
    .await?;
    bridge.store(agents.clone());
    bridge.broadcast(&BridgeMessage::Snapshot { agents });
    inner.retry_delay_ms.store(1000, Ordering::SeqCst);

    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("socket closed".to_string());
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let Some(event) = value.get("event").and_then(|event| event.as_str()) else {
            continue;
        };
        let data = value
            .get("data")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        match event {
            "pane.agent_status_changed" => {
                let Some(pane_id) = data.get("pane_id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(status) = data.get("agent_status").and_then(|v| v.as_str()) else {
                    continue;
                };
                if let Some(message) =
                    bridge.apply_status(pane_id, status, data.get("agent").and_then(|v| v.as_str()))
                {
                    bridge.broadcast(&message);
                }
            }
            "pane.agent_detected" => {
                // A new agent pane exists; re-list once (cheap local call) to
                // pick up its title and subscribe to its future status changes.
                let list = request(
                    &mut writer,
                    &mut reader,
                    "shelt:agents:refresh",
                    "agent.list",
                    "{}",
                )
                .await?;
                let agents = parse_agents(&list);
                let known: HashSet<String> = inner.agents.read().unwrap().keys().cloned().collect();
                let fresh: Vec<String> = agents
                    .iter()
                    .filter(|agent| !known.contains(&agent.pane_id))
                    .map(|agent| agent.pane_id.clone())
                    .collect();
                if !fresh.is_empty() {
                    let params = subscribe_params(&fresh);
                    request(
                        &mut writer,
                        &mut reader,
                        "shelt:subscribe:extra",
                        "events.subscribe",
                        &params,
                    )
                    .await?;
                }
                bridge.store(agents.clone());
                bridge.broadcast(&BridgeMessage::Snapshot { agents });
            }
            "pane.closed" => {
                if let Some(pane_id) = data.get("pane_id").and_then(|v| v.as_str()) {
                    if let Some(message) = bridge.remove(pane_id) {
                        bridge.broadcast(&message);
                    }
                }
            }
            _ => {}
        }
    }
}

pub async fn agent_events_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    if state.launch.mode != "herdr" {
        return secure(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Herdr agent events unavailable",
            )
                .into_response(),
        );
    }
    let (snapshot, receiver) = state.herdr_events.subscribe();
    let initial =
        Ok::<_, std::convert::Infallible>(axum::response::sse::Event::default().data(snapshot));
    let updates = futures_util::stream::unfold(receiver, move |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(message) => {
                    let event = Ok(axum::response::sse::Event::default().data(message));
                    return Some((event, receiver));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    let stream = once(async move { initial }).chain(updates);
    axum::response::sse::Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(pane_id: &str, status: &str) -> AgentInfo {
        AgentInfo {
            pane_id: pane_id.to_string(),
            status: status.to_string(),
            title: format!("Agent {pane_id}"),
            agent: "qwen".to_string(),
            cwd: "/home/admin/irds".to_string(),
        }
    }

    #[test]
    fn parse_agents_reads_pane_status_and_title() {
        let result = serde_json::json!({"agents": [
            {"pane_id": "w2:p7", "agent_status": "idle", "agent": "qwen",
             "terminal_title_stripped": "Qwen - irds", "cwd": "/home/admin/irds"},
            {"pane_id": "w2:p9", "agent_status": "done", "agent": null, "cwd": ""}
        ]});
        let agents = parse_agents(&result);
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].title, "Qwen - irds");
        assert_eq!(agents[0].status, "idle");
        assert_eq!(agents[1].title, "w2:p9");
        assert_eq!(agents[1].status, "done");
    }

    #[test]
    fn subscribe_params_lists_global_and_pane_subscriptions() {
        let params: serde_json::Value = serde_json::from_str(&subscribe_params(&[
            "w2:p7".to_string(),
            "w2:p9".to_string(),
        ]))
        .unwrap();
        let subscriptions = params["subscriptions"].as_array().unwrap();
        assert_eq!(subscriptions.len(), 4);
        assert_eq!(subscriptions[0]["type"], "pane.agent_detected");
        assert_eq!(subscriptions[1]["type"], "pane.closed");
        assert_eq!(subscriptions[2]["pane_id"], "w2:p7");
        assert_eq!(subscriptions[3]["pane_id"], "w2:p9");
    }

    #[test]
    fn apply_status_keeps_title_and_emits_message() {
        let bridge = HerdrEvents::new(PathBuf::from("/nonexistent"));
        bridge.store(vec![info("w2:p7", "working")]);
        let message = bridge.apply_status("w2:p7", "done", Some("qwen")).unwrap();
        let BridgeMessage::Status {
            pane_id,
            status,
            title,
            ..
        } = message
        else {
            panic!("expected status message");
        };
        assert_eq!(
            (pane_id.as_str(), status.as_str(), title.as_str()),
            ("w2:p7", "done", "Agent w2:p7")
        );
        assert_eq!(bridge.snapshot()[0].status, "done");
    }

    #[test]
    fn remove_only_emits_for_known_panes() {
        let bridge = HerdrEvents::new(PathBuf::from("/nonexistent"));
        bridge.store(vec![info("w2:p7", "idle")]);
        assert!(bridge.remove("w2:p7").is_some());
        assert!(bridge.remove("w2:p7").is_none());
        assert!(bridge.snapshot().is_empty());
    }
}
