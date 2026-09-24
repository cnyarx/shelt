use super::*;
use axum::extract::Path as RoutePath;
use axum::http::Method;

#[derive(Deserialize)]
pub struct ShareQuery {
    source: Option<String>,
}

fn unavailable() -> Response {
    let mut response =
        secure((StatusCode::NOT_FOUND, "分享不存在、已过期或文件不可用").into_response());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn read_shared(path: &Path, roots: &[PathBuf]) -> Option<(Vec<u8>, PreviewType)> {
    let canonical = fs::canonicalize(path).ok()?;
    if canonical != path || !within_preview_root(&canonical, roots) {
        return None;
    }
    let kind = preview_type(&canonical)?;
    let mut file = fs::File::open(&canonical).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > kind.max_bytes {
        return None;
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(kind.max_bytes + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > kind.max_bytes {
        return None;
    }
    Some((bytes, kind))
}

pub async fn manage(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
    Query(query): Query<PreviewQuery>,
) -> Response {
    if !allowed_host(&state, &headers)
        || (method != Method::GET && !allowed_origin(&state, &headers))
    {
        return secure((StatusCode::FORBIDDEN, "Forbidden").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    let requested = PathBuf::from(query.path);
    if !requested.is_absolute() {
        return unavailable();
    }
    // Keep revocation possible after the shared document has been removed.
    let path = fs::canonicalize(&requested).unwrap_or(requested);
    let result = if method == Method::DELETE {
        state
            .shares
            .revoke(&path)
            .map(|_| serde_json::json!({"ok": true}))
    } else if method == Method::GET {
        Ok(serde_json::json!({"expiresAt": state.shares.status(&path)}))
    } else {
        if read_shared(&path, &state.preview_roots).is_none() {
            return unavailable();
        }
        state.shares.create(path).map(|(key, expires)| serde_json::json!({"url": format!("/share/{key}"), "expiresAt": expires}))
    };
    let mut response = match result {
        Ok(value) => secure(Json(value).into_response()),
        Err(_) => secure((StatusCode::INTERNAL_SERVER_ERROR, "无法保存分享状态").into_response()),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn content(
    State(state): State<AppState>,
    headers: HeaderMap,
    RoutePath(token): RoutePath<String>,
    Query(query): Query<ShareQuery>,
) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden").into_response());
    }
    let Some(share) = state.shares.resolve(&token) else {
        return unavailable();
    };
    let Some((bytes, kind)) = read_shared(&share.path, &state.preview_roots) else {
        return unavailable();
    };
    if let Some(source) = query.source {
        if kind.kind != "markdown"
            || !image_sources(&String::from_utf8_lossy(&bytes)).contains(&source)
        {
            return unavailable();
        }
        if source.starts_with('#')
            || source.starts_with("//")
            || source.contains(':')
            || source.contains('\0')
        {
            return unavailable();
        }
        let target = share.path.parent().unwrap().join(&source);
        let Ok(target) = fs::canonicalize(target) else {
            return unavailable();
        };
        let Some((image, image_kind)) = read_shared(&target, &state.preview_roots) else {
            return unavailable();
        };
        if image_kind.kind != "image" && image_kind.kind != "svg" {
            return unavailable();
        }
        return preview_secure(image.into_response(), image_kind);
    }
    if kind.kind == "html" {
        return preview_secure_with_csp(
            bytes.into_response(),
            kind,
            interactive_preview::INTERACTIVE_CSP,
        );
    }
    preview_secure(bytes.into_response(), kind)
}

pub fn image_sources(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut sources = Vec::new();
    let mut paragraph = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let value = line.trim();
        let fence = value.strip_prefix("```").is_some_and(|language| {
            !language.trim().contains(char::is_whitespace) && !language.contains('`')
        });
        if fence || value.starts_with("$$") {
            sources.extend(inline_image_sources(&paragraph.join(" ")));
            paragraph.clear();
            if fence {
                index += 1;
                while index < lines.len() && lines[index].trim() != "```" {
                    index += 1;
                }
            } else {
                let mut current = &value[2..];
                while !current.contains("$$") {
                    index += 1;
                    if index == lines.len() {
                        break;
                    }
                    current = lines[index];
                }
            }
        } else if line.starts_with('>') {
            sources.extend(inline_image_sources(&paragraph.join(" ")));
            paragraph.clear();
            let mut quote = Vec::new();
            while index < lines.len() && lines[index].starts_with('>') {
                let rest = &lines[index][1..];
                quote.push(rest.strip_prefix(char::is_whitespace).unwrap_or(rest));
                index += 1;
            }
            sources.extend(image_sources(&quote.join("\n")));
            continue;
        } else if value.is_empty() {
            sources.extend(inline_image_sources(&paragraph.join(" ")));
            paragraph.clear();
        } else if line.starts_with('#')
            && line.chars().take_while(|&c| c == '#').count() <= 6
            && line
                .trim_start_matches('#')
                .starts_with(char::is_whitespace)
        {
            sources.extend(inline_image_sources(&paragraph.join(" ")));
            paragraph.clear();
            sources.extend(inline_image_sources(line));
        } else if value.chars().all(|c| c == '-') && value.len() >= 3
            || value.chars().all(|c| c == '_') && value.len() >= 3
            || value.chars().all(|c| c == '*') && value.len() >= 3
        {
            sources.extend(inline_image_sources(&paragraph.join(" ")));
            paragraph.clear();
        } else if line.contains('|')
            && lines
                .get(index + 1)
                .is_some_and(|next| table_separator(next))
        {
            sources.extend(inline_image_sources(&paragraph.join(" ")));
            paragraph.clear();
            sources.extend(table_images(line));
            index += 2;
            while index < lines.len()
                && lines[index].contains('|')
                && !lines[index].trim().is_empty()
            {
                sources.extend(table_images(lines[index]));
                index += 1;
            }
            continue;
        } else if let Some((indent, ordered, _)) = list_line(line) {
            sources.extend(inline_image_sources(&paragraph.join(" ")));
            paragraph.clear();
            index = list_images(&lines, index, indent, ordered, &mut sources);
            continue;
        } else {
            paragraph.push(value);
        }
        index += 1;
    }
    sources.extend(inline_image_sources(&paragraph.join(" ")));
    sources
}

fn table_separator(line: &str) -> bool {
    let line = line.trim();
    let line = line.strip_prefix('|').unwrap_or(line);
    let line = line.strip_suffix('|').unwrap_or(line);
    let cells: Vec<_> = line.split('|').collect();
    cells.len() >= 2
        && cells.iter().all(|cell| {
            let cell = cell.trim();
            let cell = cell.strip_prefix(':').unwrap_or(cell);
            let cell = cell.strip_suffix(':').unwrap_or(cell);
            cell.len() >= 3 && cell.chars().all(|c| c == '-')
        })
}

fn table_images(line: &str) -> Vec<String> {
    line.trim()
        .trim_matches('|')
        .split('|')
        .flat_map(|cell| inline_image_sources(cell.trim()))
        .collect()
}

fn list_line(line: &str) -> Option<(usize, bool, &str)> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    let ordered = !trimmed.starts_with(['-', '+', '*']);
    let rest = if ordered {
        let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        trimmed[digits..].strip_prefix(['.', ')'])?
    } else {
        &trimmed[1..]
    };
    if !rest.starts_with(char::is_whitespace) || rest.trim().is_empty() {
        return None;
    }
    Some((indent, ordered, rest.trim_start()))
}

fn list_images(
    lines: &[&str],
    mut index: usize,
    indent: usize,
    ordered: bool,
    sources: &mut Vec<String>,
) -> usize {
    while index < lines.len() {
        let Some((depth, kind, text)) = list_line(lines[index]) else {
            break;
        };
        if depth != indent || kind != ordered {
            break;
        }
        let mut content = vec![text];
        index += 1;
        while index < lines.len() {
            if let Some((depth, kind, _)) = list_line(lines[index]) {
                if depth > indent {
                    index = list_images(lines, index, depth, kind, sources);
                    continue;
                }
                break;
            }
            let line = lines[index];
            if line.trim().is_empty() || line.len() - line.trim_start().len() <= indent {
                break;
            }
            content.push(line.trim());
            index += 1;
        }
        sources.extend(inline_image_sources(&content.join(" ")));
        let mut next = index;
        while next < lines.len() && lines[next].trim().is_empty() {
            next += 1;
        }
        if next < lines.len()
            && list_line(lines[next])
                .is_some_and(|(depth, kind, _)| depth == indent && kind == ordered)
        {
            index = next;
        }
    }
    index
}

fn inline_image_sources(text: &str) -> Vec<String> {
    let mut visible = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;");
    for marker in ['`', '$'] {
        let mut inline = String::new();
        let mut rest = visible.as_str();
        while let Some(start) = rest.find(marker) {
            inline.push_str(&rest[..start]);
            let end = rest[start + 1..]
                .find(marker)
                .map(|offset| start + 1 + offset);
            if let Some(end) = end.filter(|&end| {
                end > start + 1
                    && (marker != '$'
                        || (start == 0 || rest.as_bytes()[start - 1] != b'\\')
                            && rest.as_bytes()[end - 1] != b'\\')
            }) {
                inline.push('\0');
                rest = &rest[end + 1..];
            } else {
                inline.push(marker);
                rest = &rest[start + 1..];
            }
        }
        inline.push_str(rest);
        visible = inline;
    }
    let mut sources = Vec::new();
    let mut rest = visible.as_str();
    while let Some(start) = rest.find("![") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find(']') else {
            break;
        };
        let suffix = &rest[end + 1..];
        if let Some(value) = suffix.strip_prefix('(') {
            if let Some(close) = value.find(')') {
                let inside = &value[..close];
                let source = inside.split_whitespace().next().unwrap_or("");
                let trailing = inside[source.len()..].trim();
                if !source.is_empty() && trailing.is_empty() {
                    sources.push(
                        source
                            .replace("&amp;", "&")
                            .replace("&quot;", "\"")
                            .replace("&#39;", "'")
                            .replace("&lt;", "<")
                            .replace("&gt;", ">"),
                    );
                    rest = &value[close + 1..];
                    continue;
                }
            }
        }
        rest = suffix;
    }
    sources
}
