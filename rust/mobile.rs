use super::*;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const NATIVE_EVENTS: &[&str] = &[
    "workspace.created",
    "workspace.closed",
    "workspace.renamed",
    "workspace.moved",
    "workspace.reordered",
    "workspace.focused",
    "tab.created",
    "tab.closed",
    "tab.renamed",
    "tab.moved",
    "tab.focused",
    "pane.created",
    "pane.closed",
    "pane.updated",
    "pane.focused",
    "pane.moved",
    "pane.exited",
    "pane.agent_detected",
    "layout.updated",
];
fn valid_pane(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":._-".contains(&b))
}
fn native_request(raw: &str) -> Option<String> {
    if raw.len() > 65536 {
        return None;
    }
    let value: Value = serde_json::from_str(raw).ok()?;
    let id = value["id"].as_str()?;
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":._-".contains(&b))
    {
        return None;
    }
    let method = value["method"].as_str()?;
    let params = &value["params"];
    let body = match method {
        "ping" | "session.snapshot" => json!({}),
        "agent.focus" => {
            let pane = params["target"].as_str()?;
            if !valid_pane(pane) {
                return None;
            }
            json!({"target": pane})
        }
        "pane.focus" => {
            let pane = params["pane_id"].as_str()?;
            if !valid_pane(pane) {
                return None;
            }
            json!({"pane_id": pane})
        }
        "pane.zoom" => {
            let pane = params["pane_id"].as_str()?;
            let mode = params["mode"].as_str()?;
            if !valid_pane(pane) || !["toggle", "on", "off"].contains(&mode) {
                return None;
            }
            json!({"pane_id": pane, "mode": mode})
        }
        "events.subscribe" => {
            let items = params["subscriptions"].as_array()?;
            if items.len() > 1024 {
                return None;
            }
            let mut subscriptions = Vec::new();
            for item in items {
                let event = item["type"].as_str()?;
                if event == "pane.agent_status_changed" {
                    let pane = item["pane_id"].as_str()?;
                    if !valid_pane(pane) {
                        return None;
                    }
                    subscriptions.push(json!({"type": event, "pane_id": pane}));
                } else if NATIVE_EVENTS.contains(&event) {
                    subscriptions.push(json!({"type": event}));
                } else {
                    return None;
                }
            }
            json!({"subscriptions": subscriptions})
        }
        _ => return None,
    };
    Some(format!(
        "{}\n",
        json!({"id": id, "method": method, "params": body})
    ))
}
struct NativeConnection {
    reader: BufReader<Box<dyn tokio::io::AsyncRead + Unpin + Send>>,
    _writer: Box<dyn tokio::io::AsyncWrite + Unpin + Send>,
    _child: Option<tokio::process::Child>,
}

async fn native_connect(
    target: Option<&targets::HerdrTarget>,
    request: &str,
) -> std::io::Result<NativeConnection> {
    let (reader, mut writer, child): (
        Box<dyn tokio::io::AsyncRead + Unpin + Send>,
        Box<dyn tokio::io::AsyncWrite + Unpin + Send>,
        Option<tokio::process::Child>,
    ) = if let Some(target) = target {
        let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        let session = target
            .session
            .as_ref()
            .map(|s| format!("--session {} ", quote(s)))
            .unwrap_or_default();
        let mut command = TokioCommand::new("ssh");
        command.args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", &target.remote,
            &format!("PATH=\"$HOME/bin:$HOME/.local/bin:$PATH\"; export PATH; exec herdr {session}remote-api-bridge")]);
        for key in [
            "HERDR_ENV",
            "HERDR_SOCKET_PATH",
            "HERDR_PANE_ID",
            "HERDR_WORKSPACE_ID",
            "HERDR_TAB_ID",
            "HERDR_CWD",
        ] {
            command.env_remove(key);
        }
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        (
            Box::new(child.stdout.take().unwrap()),
            Box::new(child.stdin.take().unwrap()),
            Some(child),
        )
    } else {
        let path = env::var_os("HERDR_SOCKET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::var_os("HERDR_CONFIG_PATH")
                    .map(PathBuf::from)
                    .and_then(|p| p.parent().map(Path::to_path_buf))
                    .unwrap_or_else(|| {
                        env::var_os("XDG_CONFIG_HOME")
                            .map(PathBuf::from)
                            .unwrap_or_else(|| {
                                PathBuf::from(env::var_os("HOME").unwrap_or_default())
                                    .join(".config")
                            })
                            .join("herdr")
                    })
                    .join("herdr.sock")
            });
        let (reader, writer) = tokio::net::UnixStream::connect(path).await?.into_split();
        (Box::new(reader), Box::new(writer), None)
    };
    writer.write_all(request.as_bytes()).await?;
    Ok(NativeConnection {
        reader: BufReader::new(reader),
        _writer: writer,
        _child: child,
    })
}

async fn native_line(
    reader: &mut BufReader<Box<dyn tokio::io::AsyncRead + Unpin + Send>>,
) -> std::io::Result<String> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf().await?;
        if bytes.is_empty() {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }
        let end = bytes.iter().position(|b| *b == b'\n');
        let count = end.map_or(bytes.len(), |i| i + 1);
        if line.len() + count > 4 * 1024 * 1024 {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
        }
        line.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if end.is_some() {
            return String::from_utf8(line)
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData));
        }
    }
}

pub async fn handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    if !allowed_host(&state, &headers) || !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    if state.launch.mode != "herdr" {
        return secure((StatusCode::SERVICE_UNAVAILABLE, "Herdr unavailable").into_response());
    }
    let (active, targets) = state.targets.list();
    if params.get("target").is_none_or(|id| *id != active) {
        return secure((StatusCode::CONFLICT, "target_changed").into_response());
    }
    let target = targets.into_iter().find(|t| t.id == active);
    ws.max_message_size(65536)
        .on_upgrade(move |socket| control(socket, state, active, target))
}
async fn forward_request(
    target: Option<targets::HerdrTarget>,
    request: String,
    output: mpsc::Sender<Option<String>>,
) {
    let value: Value = serde_json::from_str(&request).unwrap();
    let subscription = value["method"] == "events.subscribe";
    let first = tokio::time::timeout(Duration::from_secs(8), async {
        let mut connection = native_connect(target.as_ref(), &request).await?;
        let line = native_line(&mut connection.reader).await?;
        Ok::<_, std::io::Error>((connection, line))
    })
    .await;
    let (mut connection, line) = match first {
        Ok(Ok(result)) => result,
        _ => {
            let _ = output.send(Some(json!({"id":value["id"],"error":{"code":"herdr_unavailable","message":"Herdr control unavailable"}}).to_string())).await;
            return;
        }
    };
    if output.send(Some(line)).await.is_err() {
        return;
    }
    if subscription {
        loop {
            match native_line(&mut connection.reader).await {
                Ok(line) => {
                    if output.send(Some(line)).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = output.send(None).await;
                    break;
                }
            }
        }
    }
    if let Some(child) = connection._child.as_mut() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

async fn control(
    mut ws: WebSocket,
    state: AppState,
    active: String,
    target: Option<targets::HerdrTarget>,
) {
    let mut reset = state.control_reset.subscribe();
    if state.targets.list().0 != active || state.updater.is_restarting() {
        return;
    }
    let (output, mut incoming) = mpsc::channel::<Option<String>>(32);
    let mut tasks = tokio::task::JoinSet::new();
    let mut subscription: Option<tokio::task::AbortHandle> = None;
    loop {
        tokio::select! {
            _ = reset.recv() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            result = incoming.recv() => {
                if state.targets.list().0 != active { break; }
                let Some(Some(line)) = result else { break; };
                if !matches!(tokio::time::timeout(Duration::from_secs(8), ws.send(Message::Text(line.trim_end().to_owned().into()))).await, Ok(Ok(()))) { break; }
            },
            message = ws.recv() => {
                if state.targets.list().0 != active { break; }
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let Some(request) = native_request(&text) else { break; };
                        if tasks.len() >= 16 { break; }
                        let is_subscription = serde_json::from_str::<Value>(&request).unwrap()["method"] == "events.subscribe";
                        if is_subscription { if let Some(old) = subscription.take() { old.abort(); } }
                        let task = tasks.spawn(forward_request(target.clone(), request, output.clone()));
                        if is_subscription { subscription = Some(task); }
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                    _ => break,
                }
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let _ = ws.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_request_allows_pane_focus_only_for_valid_panes() {
        assert!(
            native_request(r#"{"id":"a","method":"pane.focus","params":{"pane_id":"w1:p1"}}"#)
                .is_some()
        );
        assert!(native_request(
            r#"{"id":"a","method":"pane.focus","params":{"pane_id":"bad;id"}}"#
        )
        .is_none());
        assert!(native_request(r#"{"id":"a","method":"pane.focus","params":{}}"#).is_none());
    }
}
