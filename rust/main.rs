mod auth;

use auth::{password_error, AuthStore, MAX_AUTH_BODY_BYTES};
use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env, fs,
    io::{Read, Write},
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    process::Command as TokioCommand,
    sync::{mpsc, oneshot},
};

const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MARKDOWN_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const INDEX_HTML: &[u8] = include_bytes!("../dist/index.html");
const STYLE_CSS: &[u8] = include_bytes!("../dist/style.css");
const CLIENT_CSS: &[u8] = include_bytes!("../dist/client.css");
const CLIENT_JS: &[u8] = include_bytes!("../dist/client.js");
const PREVIEW_HTML: &[u8] = include_bytes!("../dist/preview.html");
const PREVIEW_CSS: &[u8] = include_bytes!("../dist/preview.css");
const PREVIEW_JS: &[u8] = include_bytes!("../dist/preview.js");
const FAVICON_PNG: &[u8] = include_bytes!("../dist/favicon.png");
const FAVICON_16_PNG: &[u8] = include_bytes!("../dist/favicon-16.png");
const FAVICON_32_PNG: &[u8] = include_bytes!("../dist/favicon-32.png");
const FAVICON_64_PNG: &[u8] = include_bytes!("../dist/favicon-64.png");

#[derive(Clone, Debug, Serialize, PartialEq)]
struct LaunchTarget {
    mode: &'static str,
    command: PathBuf,
    args: Vec<String>,
}

struct ActiveSession {
    id: u64,
    pgid: i32,
    cancel: oneshot::Sender<()>,
}

#[derive(Clone)]
struct AppState {
    launch: LaunchTarget,
    public_hosts: Arc<HashSet<String>>,
    allowed_origins: Arc<HashSet<String>>,
    upload_dir: PathBuf,
    preview_roots: Arc<Vec<PathBuf>>,
    uploaded_paths: Arc<Mutex<HashSet<PathBuf>>>,
    active: Arc<Mutex<Option<ActiveSession>>>,
    auth: AuthStore,
    failed_logins: Arc<Mutex<u32>>,
}

#[derive(Deserialize)]
struct WsQuery {
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Deserialize)]
struct AuthRequest {
    password: String,
    #[serde(default)]
    remember: bool,
}

#[derive(Deserialize)]
struct PreviewQuery {
    path: String,
}

#[derive(Deserialize)]
struct HerdrPaneCurrentResponse {
    result: HerdrPaneCurrentResult,
}

#[derive(Deserialize)]
struct HerdrPaneCurrentResult {
    pane: HerdrPane,
}

#[derive(Deserialize)]
struct HerdrPane {
    foreground_cwd: Option<PathBuf>,
    cwd: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WikiLinkQuery {
    document_path: String,
    target: String,
    heading: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PreviewType {
    kind: &'static str,
    content_type: &'static str,
    max_bytes: u64,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "paste-path")]
    PastePath { path: String },
}

#[derive(Serialize)]
struct Health {
    ok: bool,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    match env::args().nth(1).as_deref().unwrap_or("start") {
        "start" => start_daemon().await?,
        "stop" => stop_daemon().await?,
        "restart" => {
            stop_daemon().await?;
            start_daemon().await?;
        }
        "status" => status()?,
        "url" => println!("{}", server_url()),
        "logs" => println!("{}", log_file().display()),
        "foreground" => foreground().await?,
        _ => return Err("usage: shelt [start|stop|restart|status|url|logs|foreground]".into()),
    }
    Ok(())
}

fn state_dir() -> PathBuf {
    env::var_os("SHELT_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/state"))
                .join("shelt")
        })
}
fn pid_file() -> PathBuf {
    state_dir().join("shelt.pid")
}
fn log_file() -> PathBuf {
    state_dir().join("shelt.log")
}
fn host() -> String {
    env::var("SHELT_HOST").unwrap_or_else(|_| "127.0.0.1".into())
}
fn port() -> u16 {
    env::var("SHELT_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8790)
}
fn server_url() -> String {
    format!("http://{}:{}", host(), port())
}

fn running_pid() -> Option<i32> {
    let file = pid_file();
    let pid: i32 = fs::read_to_string(&file).ok()?.trim().parse().ok()?;
    if unsafe { libc::kill(pid, 0) } == 0 {
        Some(pid)
    } else {
        let _ = fs::remove_file(file);
        None
    }
}

async fn start_daemon() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(pid) = running_pid() {
        println!("Shelt is already running (PID {pid})\n{}", server_url());
        return Ok(());
    }
    fs::create_dir_all(state_dir())?;
    fs::set_permissions(state_dir(), fs::Permissions::from_mode(0o700))?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(log_file())?;
    let mut command = Command::new(env::current_exe()?);
    command
        .arg("foreground")
        .current_dir(env::var_os("HOME").unwrap_or_else(|| ".".into()))
        .env("SHELT_DAEMON_CHILD", "1")
        .env("SHELT_STATE_DIR", state_dir())
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let child = command.spawn()?;
    fs::write(pid_file(), format!("{}\n", child.id()))?;
    fs::set_permissions(pid_file(), fs::Permissions::from_mode(0o600))?;
    for _ in 0..50 {
        if tokio::net::TcpStream::connect((host().as_str(), port()))
            .await
            .is_ok()
        {
            println!("Shelt started (PID {})\n{}", child.id(), server_url());
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = fs::remove_file(pid_file());
    Err(format!("Shelt failed to start. See {}", log_file().display()).into())
}

async fn stop_daemon() -> Result<(), Box<dyn std::error::Error>> {
    let Some(pid) = running_pid() else {
        println!("Shelt is not running");
        return Ok(());
    };
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    for _ in 0..50 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = fs::remove_file(pid_file());
    println!("Shelt stopped");
    Ok(())
}

fn status() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(pid) = running_pid() {
        println!("Shelt is running (PID {pid})\n{}", server_url());
        Ok(())
    } else {
        Err("Shelt is not running".into())
    }
}

async fn foreground() -> Result<(), Box<dyn std::error::Error>> {
    let host = host();
    let port = port();
    let launch = resolve_launch()?;
    let public_hosts = env::var("SHELT_PUBLIC_HOSTS")
        .unwrap_or_else(|_| format!("{host}:{port},localhost:{port}"));
    let allowed_origins = env::var("SHELT_ALLOWED_ORIGINS").unwrap_or_default();
    let upload_dir = env::var_os("SHELT_UPLOAD_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var_os("HERDR_PLUGIN_STATE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(env::var_os("HOME").unwrap_or_else(|| ".".into()))
                        .join(".local/state/herdr/plugins/shelt")
                })
                .join("uploads")
        });
    fs::create_dir_all(&upload_dir)?;
    fs::set_permissions(&upload_dir, fs::Permissions::from_mode(0o700))?;
    let preview_roots = preview_roots()?;
    let auth = AuthStore::load(
        state_dir().join("auth.json"),
        env::var("SHELT_SECURE_COOKIE").as_deref() == Ok("true"),
    )?;
    let state = AppState {
        launch: launch.clone(),
        public_hosts: Arc::new(
            public_hosts
                .split(',')
                .map(|v| v.trim().to_lowercase())
                .filter(|v| !v.is_empty())
                .collect(),
        ),
        allowed_origins: Arc::new(
            allowed_origins
                .split(',')
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect(),
        ),
        upload_dir,
        preview_roots: Arc::new(preview_roots),
        uploaded_paths: Arc::new(Mutex::new(HashSet::new())),
        active: Arc::new(Mutex::new(None)),
        auth,
        failed_logins: Arc::new(Mutex::new(0)),
    };
    let app = Router::new()
        .route("/ws", any(ws_handler))
        .route("/api/auth/status", get(auth_status_handler))
        .route(
            "/api/auth/setup",
            post(auth_setup_handler).layer(DefaultBodyLimit::max(MAX_AUTH_BODY_BYTES)),
        )
        .route(
            "/api/auth/login",
            post(auth_login_handler).layer(DefaultBodyLimit::max(MAX_AUTH_BODY_BYTES)),
        )
        .route("/api/auth/logout", post(auth_logout_handler))
        .route(
            "/api/upload",
            post(upload_handler).layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES)),
        )
        .route("/api/preview", get(preview_handler))
        .route(
            "/api/resolve-terminal-path",
            get(resolve_terminal_path_handler),
        )
        .route("/api/resolve-wikilink", get(resolve_wikilink_handler))
        .route("/health", get(health_handler))
        .fallback(static_handler)
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    println!(
        "Shelt listening on http://{host}:{port} ({}: {})",
        launch.mode,
        launch.command.display()
    );
    let shutdown_state = state.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    if let Some(active) = shutdown_state.active.lock().unwrap().take() {
        kill_group(active.pgid);
        let _ = active.cancel.send(());
    }
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn auth_status_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    secure(
        Json(serde_json::json!({
            "setupRequired": state.auth.setup_required(),
            "authenticated": authenticated(&state, &headers),
        }))
        .into_response(),
    )
}

async fn auth_setup_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AuthRequest>,
) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    if let Some(error) = password_error(&request.password) {
        return secure(
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error})),
            )
                .into_response(),
        );
    }
    match state.auth.setup(&request.password) {
        Ok(true) => {
            let token = state.auth.create_session(request.remember);
            with_cookie(
                secure(Json(serde_json::json!({"ok": true})).into_response()),
                state.auth.session_cookie(&token, request.remember),
            )
        }
        Ok(false) => secure(
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error": "Password is already configured"})),
            )
                .into_response(),
        ),
        Err(error) => secure(
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response(),
        ),
    }
}

async fn auth_login_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AuthRequest>,
) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    if password_error(&request.password).is_some() || !state.auth.verify(&request.password) {
        let delay = {
            let mut failures = state.failed_logins.lock().unwrap();
            *failures = (*failures + 1).min(6);
            Duration::from_millis((100u64 * 2u64.pow(*failures - 1)).min(2000))
        };
        tokio::time::sleep(delay).await;
        return secure(
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Invalid password"})),
            )
                .into_response(),
        );
    }
    *state.failed_logins.lock().unwrap() = 0;
    let token = state.auth.create_session(request.remember);
    with_cookie(
        secure(Json(serde_json::json!({"ok": true})).into_response()),
        state.auth.session_cookie(&token, request.remember),
    )
}

async fn auth_logout_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    state.auth.revoke(cookie_header(&headers));
    with_cookie(
        secure(Json(serde_json::json!({"ok": true})).into_response()),
        state.auth.expired_cookie(),
    )
}

async fn health_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    secure(Json(Health { ok: true }).into_response())
}

async fn preview_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PreviewQuery>,
) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    let requested = Path::new(&query.path);
    if !requested.is_absolute() {
        return secure((StatusCode::BAD_REQUEST, "Absolute path required").into_response());
    }
    let Some(preview_type) = preview_type(requested) else {
        return secure(
            (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Unsupported preview type",
            )
                .into_response(),
        );
    };
    let canonical = match fs::canonicalize(requested) {
        Ok(path) => path,
        Err(_) => return secure((StatusCode::NOT_FOUND, "Not found").into_response()),
    };
    if !within_preview_root(&canonical, &state.preview_roots) {
        return secure((StatusCode::FORBIDDEN, "Path is outside preview roots").into_response());
    }
    let metadata = match fs::metadata(&canonical) {
        Ok(metadata) => metadata,
        Err(_) => return secure((StatusCode::NOT_FOUND, "Not found").into_response()),
    };
    if !metadata.is_file() {
        return secure((StatusCode::UNSUPPORTED_MEDIA_TYPE, "Not a regular file").into_response());
    }
    if metadata.len() > preview_type.max_bytes {
        return secure(
            (StatusCode::PAYLOAD_TOO_LARGE, "Preview file is too large").into_response(),
        );
    }
    match fs::read(canonical) {
        Ok(bytes) => preview_secure(bytes.into_response(), preview_type),
        Err(_) => secure((StatusCode::NOT_FOUND, "Unable to read file").into_response()),
    }
}

async fn resolve_terminal_path_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PreviewQuery>,
) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    let relative = Path::new(&query.path);
    if relative.is_absolute() || query.path.contains('\0') || preview_type(relative).is_none() {
        return secure(
            (StatusCode::BAD_REQUEST, "Supported relative path required").into_response(),
        );
    }
    let cwd = match focused_pane_cwd(&state.launch).await {
        Ok(path) => path,
        Err(message) => return secure((StatusCode::SERVICE_UNAVAILABLE, message).into_response()),
    };
    let target = match fs::canonicalize(cwd.join(relative)) {
        Ok(path) => path,
        Err(_) => return secure((StatusCode::NOT_FOUND, "Not found").into_response()),
    };
    if !within_preview_root(&target, &state.preview_roots) {
        return secure((StatusCode::FORBIDDEN, "Path is outside preview roots").into_response());
    }
    if preview_type(&target).is_none()
        || !fs::metadata(&target).is_ok_and(|metadata| metadata.is_file())
    {
        return secure(
            (StatusCode::UNSUPPORTED_MEDIA_TYPE, "Invalid preview target").into_response(),
        );
    }
    redirect_to_preview(&target)
}

async fn focused_pane_cwd(launch: &LaunchTarget) -> Result<PathBuf, &'static str> {
    if launch.mode != "herdr" {
        return Err("Relative terminal paths require Herdr mode");
    }
    let mut command = TokioCommand::new(&launch.command);
    command
        .arg("pane")
        .arg("current")
        .env_remove("HERDR_PANE_ID")
        .env_remove("HERDR_WORKSPACE_ID")
        .env_remove("HERDR_TAB_ID")
        .env_remove("HERDR_CWD")
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(2), command.output())
        .await
        .map_err(|_| "Timed out reading the focused Herdr pane")?
        .map_err(|_| "Unable to query the focused Herdr pane")?;
    if !output.status.success() {
        return Err("Unable to query the focused Herdr pane");
    }
    let cwd = parse_herdr_pane_cwd(&output.stdout)?;
    if !cwd.is_absolute() {
        return Err("Focused Herdr pane returned an invalid working directory");
    }
    Ok(cwd)
}

fn parse_herdr_pane_cwd(output: &[u8]) -> Result<PathBuf, &'static str> {
    let response: HerdrPaneCurrentResponse = serde_json::from_slice(output)
        .map_err(|_| "Invalid response from the focused Herdr pane")?;
    Ok(response
        .result
        .pane
        .foreground_cwd
        .unwrap_or(response.result.pane.cwd))
}

fn redirect_to_preview(path: &Path) -> Response {
    let location = format!(
        "/preview?path={}",
        percent_encode(path.to_string_lossy().as_bytes())
    );
    let mut response = StatusCode::FOUND.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&location).expect("encoded redirect location"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    secure(response)
}

async fn resolve_wikilink_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<WikiLinkQuery>,
) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    let document = match fs::canonicalize(&query.document_path) {
        Ok(path) => path,
        Err(_) => {
            return secure((StatusCode::NOT_FOUND, "Source document not found").into_response())
        }
    };
    if !within_preview_root(&document, &state.preview_roots)
        || preview_type(&document).is_none_or(|value| value.kind != "markdown")
        || !fs::metadata(&document).is_ok_and(|metadata| metadata.is_file())
    {
        return secure((StatusCode::FORBIDDEN, "Invalid source document").into_response());
    }
    for candidate in wiki_link_candidates(&document, &query.target, &state.preview_roots) {
        let Ok(target) = fs::canonicalize(candidate) else {
            continue;
        };
        if !within_preview_root(&target, &state.preview_roots)
            || preview_type(&target).is_none_or(|value| value.kind != "markdown")
            || !fs::metadata(&target).is_ok_and(|metadata| metadata.is_file())
        {
            continue;
        }
        let mut location = format!(
            "/preview?path={}",
            percent_encode(target.to_string_lossy().as_bytes())
        );
        if let Some(heading) = query.heading.filter(|value| !value.is_empty()) {
            location.push('#');
            location.push_str(&percent_encode(heading.as_bytes()));
        }
        let mut response = StatusCode::FOUND.into_response();
        response.headers_mut().insert(
            header::LOCATION,
            HeaderValue::from_str(&location).expect("encoded redirect location"),
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return secure(response);
    }
    secure((StatusCode::NOT_FOUND, "Wiki link not found").into_response())
}

async fn static_handler(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    let (bytes, content_type) = match uri.path() {
        "/" | "/index.html" => (INDEX_HTML, "text/html; charset=utf-8"),
        "/style.css" => (STYLE_CSS, "text/css; charset=utf-8"),
        "/client.css" => (CLIENT_CSS, "text/css; charset=utf-8"),
        "/client.js" => (CLIENT_JS, "text/javascript; charset=utf-8"),
        "/preview" | "/preview.html" => (PREVIEW_HTML, "text/html; charset=utf-8"),
        "/preview.css" => (PREVIEW_CSS, "text/css; charset=utf-8"),
        "/preview.js" => (PREVIEW_JS, "text/javascript; charset=utf-8"),
        "/favicon.png" => (FAVICON_PNG, "image/png"),
        "/favicon-16.png" => (FAVICON_16_PNG, "image/png"),
        "/favicon-32.png" => (FAVICON_32_PNG, "image/png"),
        "/favicon-64.png" => (FAVICON_64_PNG, "image/png"),
        _ => return secure((StatusCode::NOT_FOUND, "Not found").into_response()),
    };
    let mut response = bytes.to_vec().into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    secure(response)
}

async fn upload_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    let Some(extension) = image_extension(content_type) else {
        return secure(
            (StatusCode::UNSUPPORTED_MEDIA_TYPE, "Unsupported image type").into_response(),
        );
    };
    if body.is_empty() || body.len() > MAX_IMAGE_BYTES {
        return secure((StatusCode::PAYLOAD_TOO_LARGE, "Invalid image size").into_response());
    }
    if !has_image_signature(&body, extension) {
        return secure(
            (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Image signature mismatch",
            )
                .into_response(),
        );
    }
    let upload_name = headers
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(decode_upload_name);
    let stem = safe_upload_stem(upload_name.as_deref());
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = state.upload_dir.join(format!("{stem}-{nonce}.{extension}"));
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .and_then(|mut f| f.write_all(&body))
    {
        Ok(()) => {
            state.uploaded_paths.lock().unwrap().insert(path.clone());
            secure(Json(serde_json::json!({"ok":true,"path":path})).into_response())
        }
        Err(error) => {
            secure((StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response())
        }
    }
}

async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    let cols = query.cols.unwrap_or(120).clamp(1, 1000);
    let rows = query.rows.unwrap_or(40).clamp(1, 500);
    ws.max_message_size(1024 * 1024)
        .on_upgrade(move |socket| session(socket, state, cols, rows))
}

async fn session(socket: WebSocket, state: AppState, cols: u16, rows: u16) {
    let pty = native_pty_system();
    let pair = match pty.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut command = CommandBuilder::new(&state.launch.command);
    command.cwd(env::var_os("HOME").unwrap_or_else(|| ".".into()));
    for key in [
        "HERDR_ENV",
        "HERDR_PANE_ID",
        "HERDR_WORKSPACE_ID",
        "HERDR_TAB_ID",
        "HERDR_CWD",
        "HERDR_RENDER_ENCODING",
    ] {
        command.env_remove(key);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "shelt");
    let child = match pair.slave.spawn_command(command) {
        Ok(v) => v,
        Err(_) => return,
    };
    let pgid = pair.master.process_group_leader().unwrap_or_default();
    drop(pair.slave);
    let mut reader = match pair.master.try_clone_reader() {
        Ok(v) => v,
        Err(_) => {
            kill_group(pgid);
            return;
        }
    };
    let mut writer = match pair.master.take_writer() {
        Ok(v) => v,
        Err(_) => {
            kill_group(pgid);
            return;
        }
    };
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    if let Some(old) = state.active.lock().unwrap().replace(ActiveSession {
        id,
        pgid,
        cancel: cancel_tx,
    }) {
        kill_group(old.pgid);
        let _ = old.cancel.send(());
    }
    let (pty_tx, mut pty_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || pty_tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let (exit_tx, mut exit_rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
        let _ = exit_tx.send(());
    });
    let (mut ws_tx, mut ws_rx) = socket.split();
    loop {
        tokio::select! {
            _ = &mut cancel_rx => break,
            _ = exit_rx.recv() => break,
            Some(data) = pty_rx.recv() => if ws_tx.send(Message::binary(data)).await.is_err() { break; },
            message = ws_rx.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let Ok(message) = serde_json::from_slice::<ClientMessage>(text.as_bytes()) else { break; };
                    match message {
                        ClientMessage::Input { data } if writer.write_all(data.as_bytes()).is_err() => break,
                        ClientMessage::Resize { cols, rows } if (1..=1000).contains(&cols) && (1..=500).contains(&rows) => { let _ = pair.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }); }
                        ClientMessage::PastePath { path } => {
                            let path = PathBuf::from(path);
                            if state.uploaded_paths.lock().unwrap().remove(&path) { let _ = writer.write_all(bracketed_paste(path.to_string_lossy().as_ref()).as_bytes()); }
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    let Ok(message) = serde_json::from_slice::<ClientMessage>(&bytes) else { break; };
                    match message {
                        ClientMessage::Input { data } if writer.write_all(data.as_bytes()).is_err() => break,
                        ClientMessage::Resize { cols, rows } if (1..=1000).contains(&cols) && (1..=500).contains(&rows) => { let _ = pair.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }); }
                        ClientMessage::PastePath { path } => {
                            let path = PathBuf::from(path);
                            if state.uploaded_paths.lock().unwrap().remove(&path) { let _ = writer.write_all(bracketed_paste(path.to_string_lossy().as_ref()).as_bytes()); }
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    kill_group(pgid);
    let mut active = state.active.lock().unwrap();
    if active.as_ref().is_some_and(|session| session.id == id) {
        *active = None;
    }
}

fn kill_group(pgid: i32) {
    if pgid > 0 {
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
}
fn with_cookie(mut response: Response, cookie: String) -> Response {
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}
fn cookie_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
}
fn authenticated(state: &AppState, headers: &HeaderMap) -> bool {
    state.auth.authenticated(cookie_header(headers))
}
fn preview_secure(mut response: Response, preview_type: PreviewType) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(preview_type.content_type),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    headers.insert(
        "x-shelt-preview-kind",
        HeaderValue::from_static(preview_type.kind),
    );
    headers.insert("content-security-policy", HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}
fn secure(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}
fn allowed_host(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| state.public_hosts.contains(&v.to_lowercase()))
}
fn allowed_origin(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    if state.allowed_origins.contains(origin) {
        return true;
    }
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    origin
        .parse::<Uri>()
        .ok()
        .and_then(|uri| {
            uri.authority()
                .map(|authority| authority.as_str().to_lowercase())
        })
        .is_some_and(|authority| authority == host.to_lowercase())
}
fn image_extension(content_type: &str) -> Option<&'static str> {
    match content_type.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}
fn preview_roots() -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let configured = env::var_os("SHELT_PREVIEW_ROOTS")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .filter(|roots| !roots.is_empty())
        .unwrap_or_else(|| env::var_os("HOME").map(PathBuf::from).into_iter().collect());
    configured
        .into_iter()
        .map(fs::canonicalize)
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}
fn preview_type(path: &Path) -> Option<PreviewType> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "md" | "markdown" => Some(PreviewType {
            kind: "markdown",
            content_type: "text/markdown; charset=utf-8",
            max_bytes: MAX_MARKDOWN_BYTES,
        }),
        "html" | "htm" => Some(PreviewType {
            kind: "html",
            content_type: "text/html; charset=utf-8",
            max_bytes: MAX_DOCUMENT_BYTES,
        }),
        "svg" => Some(PreviewType {
            kind: "svg",
            content_type: "image/svg+xml; charset=utf-8",
            max_bytes: MAX_DOCUMENT_BYTES,
        }),
        "png" => Some(PreviewType {
            kind: "image",
            content_type: "image/png",
            max_bytes: MAX_PREVIEW_IMAGE_BYTES,
        }),
        "jpg" | "jpeg" => Some(PreviewType {
            kind: "image",
            content_type: "image/jpeg",
            max_bytes: MAX_PREVIEW_IMAGE_BYTES,
        }),
        "gif" => Some(PreviewType {
            kind: "image",
            content_type: "image/gif",
            max_bytes: MAX_PREVIEW_IMAGE_BYTES,
        }),
        "webp" => Some(PreviewType {
            kind: "image",
            content_type: "image/webp",
            max_bytes: MAX_PREVIEW_IMAGE_BYTES,
        }),
        _ => None,
    }
}
fn within_preview_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}
fn wiki_link_candidates(document: &Path, target: &str, roots: &[PathBuf]) -> Vec<PathBuf> {
    if target.is_empty()
        || Path::new(target).is_absolute()
        || target
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return vec![];
    }
    let extensions: &[&str] = if target.to_ascii_lowercase().ends_with(".md")
        || target.to_ascii_lowercase().ends_with(".markdown")
    {
        &[""]
    } else {
        &[".md", ".markdown"]
    };
    let mut candidates = vec![];
    let Some(mut directory) = document.parent() else {
        return candidates;
    };
    while within_preview_root(directory, roots) {
        for extension in extensions {
            candidates.push(directory.join(format!("{target}{extension}")));
        }
        let Some(parent) = directory.parent() else {
            break;
        };
        if parent == directory {
            break;
        }
        directory = parent;
    }
    candidates
}
fn percent_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len());
    for byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
fn has_image_signature(bytes: &[u8], extension: &str) -> bool {
    match extension {
        "png" => bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "bmp" => bytes.starts_with(b"BM"),
        _ => false,
    }
}
fn decode_upload_name(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let encoded = bytes.get(index + 1..index + 3)?;
            let text = std::str::from_utf8(encoded).ok()?;
            decoded.push(u8::from_str_radix(text, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn safe_upload_stem(name: Option<&str>) -> String {
    let base = Path::new(name.unwrap_or("clipboard"))
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("clipboard");
    let stem = Path::new(base)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("clipboard");
    let safe: String = stem
        .chars()
        .take(80)
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    let safe = safe.trim_matches('-');
    if safe.is_empty() {
        "clipboard".into()
    } else {
        safe.into()
    }
}
fn bracketed_paste(text: &str) -> String {
    format!("\x1b[200~{text}\x1b[201~")
}

fn resolve_launch() -> Result<LaunchTarget, Box<dyn std::error::Error>> {
    resolve_launch_with(&env::vars().collect(), which, passwd_shell())
}

fn resolve_launch_with(
    environment: &std::collections::HashMap<String, String>,
    resolver: impl Fn(&str) -> Option<PathBuf>,
    passwd: Option<String>,
) -> Result<LaunchTarget, Box<dyn std::error::Error>> {
    let mode = environment
        .get("SHELT_MODE")
        .cloned()
        .unwrap_or_else(|| "auto".into())
        .to_lowercase();
    if !matches!(mode.as_str(), "auto" | "herdr" | "shell") {
        return Err(format!("Invalid SHELT_MODE={mode}; expected auto, herdr, or shell").into());
    }
    let herdr_name = environment
        .get("SHELT_HERDR_BIN")
        .cloned()
        .unwrap_or_else(|| "herdr".into());
    let herdr = resolver(&herdr_name);
    if mode == "herdr" {
        return herdr
            .map(|command| LaunchTarget {
                mode: "herdr",
                command,
                args: vec![],
            })
            .ok_or_else(|| format!("SHELT_MODE=herdr but {herdr_name} was not found").into());
    }
    if mode == "auto" {
        if let Some(command) = herdr {
            return Ok(LaunchTarget {
                mode: "herdr",
                command,
                args: vec![],
            });
        }
    }
    for candidate in [
        environment.get("SHELT_SHELL").cloned(),
        environment.get("SHELL").cloned(),
        passwd,
        Some("bash".into()),
        Some("zsh".into()),
        Some("sh".into()),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(command) = resolver(&candidate) {
            return Ok(LaunchTarget {
                mode: "shell",
                command,
                args: vec![],
            });
        }
    }
    Err("No usable shell found. Set SHELT_SHELL to an executable shell path.".into())
}
fn which(command: &str) -> Option<PathBuf> {
    if command.contains(['\0', '\n', '\r']) {
        return None;
    }
    let path = Path::new(command);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }
    env::split_paths(&env::var_os("PATH")?)
        .map(|p| p.join(command))
        .find(|p| p.is_file())
}
fn passwd_shell() -> Option<String> {
    let uid = unsafe { libc::getuid() };
    fs::read_to_string("/etc/passwd")
        .ok()?
        .lines()
        .find_map(|line| {
            let f: Vec<_> = line.split(':').collect();
            (f.len() >= 7 && f[2].parse::<u32>().ok() == Some(uid)).then(|| f[6].to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_security() {
        assert_eq!(image_extension("image/png"), Some("png"));
        assert!(has_image_signature(
            &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
            "png"
        ));
        assert!(!has_image_signature(b"bad", "png"));
    }
    #[test]
    fn upload_names_and_paste() {
        assert_eq!(
            decode_upload_name("formal-%E4%B8%AD%E6%96%87.png").as_deref(),
            Some("formal-中文.png")
        );
        assert_eq!(
            decode_upload_name("..%2F..%2Fmy%20screenshot.png").as_deref(),
            Some("../../my screenshot.png")
        );
        assert_eq!(decode_upload_name("broken-%ZZ.png"), None);
        assert_eq!(
            safe_upload_stem(decode_upload_name("..%2F..%2Fmy%20screenshot.png").as_deref()),
            "my-screenshot"
        );
        assert_eq!(
            bracketed_paste("/tmp/a.png"),
            "\x1b[200~/tmp/a.png\x1b[201~"
        );
    }

    #[test]
    fn request_origin_matches_host_or_explicit_allowlist() {
        let state = AppState {
            launch: LaunchTarget {
                mode: "shell",
                command: PathBuf::from("/bin/sh"),
                args: vec![],
            },
            public_hosts: Arc::new(HashSet::new()),
            allowed_origins: Arc::new(HashSet::from(["https://proxy.example".into()])),
            upload_dir: PathBuf::new(),
            preview_roots: Arc::new(vec![PathBuf::from("/home/user")]),
            uploaded_paths: Arc::new(Mutex::new(HashSet::new())),
            active: Arc::new(Mutex::new(None)),
            auth: AuthStore::load(
                env::temp_dir().join(format!("shelt-auth-test-{}", std::process::id())),
                false,
            )
            .unwrap(),
            failed_logins: Arc::new(Mutex::new(0)),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_static("terminal.example:443"),
        );
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://terminal.example:443"),
        );
        assert!(allowed_origin(&state, &headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://proxy.example"),
        );
        assert!(allowed_origin(&state, &headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        assert!(!allowed_origin(&state, &headers));
    }

    #[test]
    fn preview_types_and_roots_are_bounded() {
        assert_eq!(
            preview_type(Path::new("/tmp/README.MD")),
            Some(PreviewType {
                kind: "markdown",
                content_type: "text/markdown; charset=utf-8",
                max_bytes: MAX_MARKDOWN_BYTES,
            })
        );
        assert_eq!(
            preview_type(Path::new("/tmp/photo.jpeg")).map(|value| value.max_bytes),
            Some(MAX_PREVIEW_IMAGE_BYTES)
        );
        assert_eq!(preview_type(Path::new("/tmp/report.pdf")), None);
        assert!(within_preview_root(
            Path::new("/home/user/docs/readme.md"),
            &[PathBuf::from("/home/user")]
        ));
        assert!(!within_preview_root(
            Path::new("/home/user-other/readme.md"),
            &[PathBuf::from("/home/user")]
        ));
        assert_eq!(
            wiki_link_candidates(
                Path::new("/home/user/vault/计算机学/长上下文.md"),
                "物理学/弦理论",
                &[PathBuf::from("/home/user/vault")],
            ),
            vec![
                PathBuf::from("/home/user/vault/计算机学/物理学/弦理论.md"),
                PathBuf::from("/home/user/vault/计算机学/物理学/弦理论.markdown"),
                PathBuf::from("/home/user/vault/物理学/弦理论.md"),
                PathBuf::from("/home/user/vault/物理学/弦理论.markdown"),
            ]
        );
        assert!(wiki_link_candidates(
            Path::new("/home/user/vault/readme.md"),
            "../secret",
            &[PathBuf::from("/home/user/vault")],
        )
        .is_empty());
        assert_eq!(
            percent_encode("/路径 a.md".as_bytes()),
            "%2F%E8%B7%AF%E5%BE%84%20a.md"
        );
    }

    #[test]
    fn herdr_pane_cwd_prefers_foreground_and_falls_back_to_creation_cwd() {
        assert_eq!(
            parse_herdr_pane_cwd(
                br#"{"result":{"pane":{"cwd":"/home/user","foreground_cwd":"/home/user/project"}}}"#,
            ),
            Ok(PathBuf::from("/home/user/project"))
        );
        assert_eq!(
            parse_herdr_pane_cwd(
                br#"{"result":{"pane":{"cwd":"/home/user","foreground_cwd":null}}}"#,
            ),
            Ok(PathBuf::from("/home/user"))
        );
        assert!(parse_herdr_pane_cwd(b"not json").is_err());
    }

    #[test]
    fn launch_defaults_to_herdr_without_arguments() {
        let bins = std::collections::HashMap::from([
            ("herdr", PathBuf::from("/usr/bin/herdr")),
            ("bash", PathBuf::from("/bin/bash")),
        ]);
        let target = resolve_launch_with(
            &std::collections::HashMap::new(),
            |command| bins.get(command).cloned(),
            Some("/bin/bash".into()),
        )
        .unwrap();
        assert_eq!(target.mode, "herdr");
        assert_eq!(target.command, PathBuf::from("/usr/bin/herdr"));
        assert!(target.args.is_empty());
    }

    #[test]
    fn launch_supports_explicit_shell_and_rejects_invalid_mode() {
        let shell = std::collections::HashMap::from([
            ("SHELT_MODE".into(), "shell".into()),
            ("SHELT_SHELL".into(), "/custom/fish".into()),
        ]);
        let target = resolve_launch_with(
            &shell,
            |command| (command == "/custom/fish").then(|| PathBuf::from(command)),
            None,
        )
        .unwrap();
        assert_eq!(target.mode, "shell");
        assert!(target.args.is_empty());

        let invalid = std::collections::HashMap::from([("SHELT_MODE".into(), "other".into())]);
        assert!(resolve_launch_with(&invalid, |_| None, None).is_err());
    }
}
