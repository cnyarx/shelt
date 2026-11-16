use super::*;
use rand_core::{OsRng, RngCore};
use std::collections::HashMap;

pub const INTERACTIVE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http: https: blob:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src http: https: ws: wss:; worker-src blob:; frame-src 'none'; object-src 'none'; sandbox allow-scripts; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

#[derive(Clone)]
struct Grant {
    directory: PathBuf,
    session: String,
    expires: SystemTime,
}

#[derive(Clone, Default)]
pub struct InteractivePreviews(Arc<Mutex<HashMap<String, Grant>>>);

impl InteractivePreviews {
    fn valid(grant: &Grant, auth: &AuthStore) -> bool {
        grant.expires > SystemTime::now()
            && auth.authenticated(Some(&format!("{}={}", auth::SESSION_COOKIE, grant.session)))
    }
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(query): Json<PreviewQuery>,
) -> Response {
    if !allowed_host(&state, &headers) || !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    let requested = Path::new(&query.path);
    if !requested.is_absolute() {
        return secure((StatusCode::BAD_REQUEST, "Absolute path required").into_response());
    }
    let Ok(path) = fs::canonicalize(requested) else {
        return unavailable();
    };
    if !within_preview_root(&path, &state.preview_roots)
        || preview_type(&path).is_none_or(|kind| kind.kind != "html")
    {
        return unavailable();
    }
    let session = cookie_header(&headers)
        .and_then(|cookie| auth::parse_cookie(cookie, auth::SESSION_COOKIE))
        .unwrap()
        .to_string();
    let grant = Grant {
        directory: path.parent().unwrap().to_path_buf(),
        session,
        expires: SystemTime::now() + Duration::from_secs(24 * 60 * 60),
    };
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return unavailable();
    };
    if !matches!(read_file(&state, &grant, name), ReadOutcome::Ready(_, _)) {
        return unavailable();
    }
    let mut random = [0u8; 32];
    OsRng.fill_bytes(&mut random);
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let url = format!(
        "/api/preview-content/{token}/{}",
        percent_encode(name.as_bytes())
    );
    let mut grants = state.interactive_previews.0.lock().unwrap();
    grants.retain(|_, grant| InteractivePreviews::valid(grant, &state.auth));
    grants.insert(token.clone(), grant);
    let mut response =
        secure(Json(serde_json::json!({"token": token, "url": url})).into_response());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if !allowed_host(&state, &headers) || !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    let session =
        cookie_header(&headers).and_then(|cookie| auth::parse_cookie(cookie, auth::SESSION_COOKIE));
    let mut grants = state.interactive_previews.0.lock().unwrap();
    if grants
        .get(&token)
        .is_some_and(|grant| Some(grant.session.as_str()) == session)
    {
        grants.remove(&token);
    }
    secure(StatusCode::NO_CONTENT.into_response())
}

pub async fn content(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path((token, resource)): axum::extract::Path<(String, String)>,
) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    let grant = state
        .interactive_previews
        .0
        .lock()
        .unwrap()
        .get(&token)
        .cloned();
    let Some(grant) = grant else {
        return unavailable();
    };
    if !InteractivePreviews::valid(&grant, &state.auth) {
        state.interactive_previews.0.lock().unwrap().remove(&token);
        return unavailable();
    }
    let (bytes, content_type) = match read_file(&state, &grant, &resource) {
        ReadOutcome::Ready(bytes, content_type) => (bytes, content_type),
        ReadOutcome::TooLarge => return too_large(),
        ReadOutcome::Unavailable => return unavailable(),
    };
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(INTERACTIVE_CSP),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}

fn unavailable() -> Response {
    let mut response =
        secure((StatusCode::NOT_FOUND, "预览资源不可用，请刷新预览页").into_response());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn too_large() -> Response {
    let mut response =
        secure((StatusCode::PAYLOAD_TOO_LARGE, "预览资源超出大小限制").into_response());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

enum ReadOutcome {
    Ready(Vec<u8>, &'static str),
    TooLarge,
    Unavailable,
}

fn read_file(state: &AppState, grant: &Grant, resource: &str) -> ReadOutcome {
    if resource.is_empty()
        || Path::new(resource).is_absolute()
        || resource.contains(['\\', '\0'])
        || resource.split('/').any(|part| part.starts_with('.'))
    {
        return ReadOutcome::Unavailable;
    }
    let Ok(canonical) = fs::canonicalize(grant.directory.join(resource)) else {
        return ReadOutcome::Unavailable;
    };
    let Ok(private_directory) = fs::canonicalize(state_dir()) else {
        return ReadOutcome::Unavailable;
    };
    if !canonical.starts_with(&grant.directory)
        || !within_preview_root(&canonical, &state.preview_roots)
        || canonical.starts_with(private_directory)
        || canonical
            .strip_prefix(&grant.directory)
            .map(|rest| {
                rest.components()
                    .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
            })
            .unwrap_or(true)
    {
        return ReadOutcome::Unavailable;
    }
    let (content_type, max_bytes) = if let Some(kind) = preview_type(&canonical) {
        if kind.kind == "markdown" {
            return ReadOutcome::Unavailable;
        }
        (kind.content_type, Some(kind.max_bytes))
    } else {
        let Some(extension) = canonical.extension().and_then(|ext| ext.to_str()) else {
            return ReadOutcome::Unavailable;
        };
        let content_type = match extension.to_ascii_lowercase().as_str() {
            "js" | "mjs" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "json" => "application/json",
            "csv" => "text/csv; charset=utf-8",
            "txt" => "text/plain; charset=utf-8",
            "wasm" => "application/wasm",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "ico" => "image/x-icon",
            "avif" => "image/avif",
            "bmp" => "image/bmp",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "ogg" => "audio/ogg",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            _ => return ReadOutcome::Unavailable,
        };
        let max_bytes = if content_type.starts_with("text/javascript") {
            None
        } else if content_type.starts_with("text/") || content_type == "application/json" {
            Some(MAX_DOCUMENT_BYTES)
        } else {
            Some(MAX_PREVIEW_IMAGE_BYTES)
        };
        (content_type, max_bytes)
    };
    let Ok(mut file) = fs::File::open(&canonical) else {
        return ReadOutcome::Unavailable;
    };
    let Ok(metadata) = file.metadata() else {
        return ReadOutcome::Unavailable;
    };
    if !metadata.is_file() {
        return ReadOutcome::Unavailable;
    }
    if max_bytes.is_some_and(|max| metadata.len() > max) {
        return ReadOutcome::TooLarge;
    }
    let limit = max_bytes.unwrap_or(metadata.len());
    let mut bytes = Vec::new();
    if (&mut file).take(limit + 1).read_to_end(&mut bytes).is_err() {
        return ReadOutcome::Unavailable;
    }
    if max_bytes.is_some_and(|max| bytes.len() as u64 > max) {
        return ReadOutcome::TooLarge;
    }
    bytes.truncate(limit as usize);
    ReadOutcome::Ready(bytes, content_type)
}
