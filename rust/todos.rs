use super::*;
use rand_core::{OsRng, RngCore};
use ring::digest::{digest, SHA256};
use serde_json::{json, Value};
use std::collections::HashMap;

const STATES: [&str; 5] = ["todo", "doing", "blocked", "done", "canceled"];
type Error = (StatusCode, &'static str);
type Result<T> = std::result::Result<T, Error>;
fn fail(status: StatusCode, code: &'static str) -> Error {
    (status, code)
}
fn invalid(code: &'static str) -> Error {
    fail(StatusCode::BAD_REQUEST, code)
}
fn storage(_: impl std::fmt::Debug) -> Error {
    fail(StatusCode::SERVICE_UNAVAILABLE, "todo_storage_unavailable")
}
fn hash(text: &[u8]) -> String {
    digest(&SHA256, text)
        .as_ref()
        .iter()
        .map(|n| format!("{n:02x}"))
        .collect()
}
fn id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|n| format!("{n:02x}")).collect()
}
fn valid_id(text: &str) -> bool {
    text.len() == 32
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn number(value: &Value) -> bool {
    value
        .as_i64()
        .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
}
fn text(value: &Value, max: usize, required: bool) -> bool {
    value.as_str().is_some_and(|s| {
        s.chars().count() <= max
            && (!required || !s.trim().is_empty())
            && !s.chars().any(|c| matches!(c as u32,0..=8|11..=31|127))
    })
}
fn empty() -> Value {
    json!({"version":1,"revision":0,"projects":[],"items":[],"tokens":[],"receipts":{}})
}
fn array<'a>(data: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    data[key].as_array().ok_or(invalid("invalid_data"))
}
fn checked(data: &Value) -> Result<()> {
    if data["version"] != 1
        || data["revision"]
            .as_u64()
            .is_none_or(|n| n > 9_007_199_254_740_991)
        || !data["tokens"].is_array()
        || !data["receipts"].is_object()
    {
        return Err(invalid("invalid_data"));
    }
    let projects = array(data, "projects")?;
    let items = array(data, "items")?;
    let mut ids = HashSet::new();
    for node in projects.iter().chain(items) {
        if !node["id"].as_str().is_some_and(valid_id)
            || !ids.insert(node["id"].as_str().unwrap())
            || !text(&node["title"], 160, true)
            || !text(&node["description"], 8000, false)
            || !number(&node["order"])
            || !number(&node["revision"])
        {
            return Err(invalid("invalid_node"));
        }
    }
    for node in items {
        let kind = node["kind"].as_str().unwrap_or("");
        if !projects.iter().any(|p| p["id"] == node["projectId"])
            || !matches!(kind, "folder" | "task")
            || if kind == "folder" {
                !node["status"].is_null()
            } else {
                !STATES.contains(&node["status"].as_str().unwrap_or(""))
            }
        {
            return Err(invalid("invalid_node"));
        }
        let mut current = node;
        let mut seen = HashSet::from([node["id"].as_str().unwrap()]);
        let mut depth = 0;
        while !current["parentId"].is_null() {
            let parent = items
                .iter()
                .find(|p| p["id"] == current["parentId"])
                .ok_or(invalid("invalid_parent"))?;
            depth += 1;
            if parent["kind"] != "folder"
                || parent["projectId"] != node["projectId"]
                || !seen.insert(parent["id"].as_str().unwrap())
                || depth > 16
            {
                return Err(invalid("invalid_parent"));
            }
            current = parent;
        }
    }
    Ok(())
}
fn descendants(data: &Value, root: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut queue = vec![root.to_string()];
    while let Some(parent) = queue.pop() {
        for item in data["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i["parentId"] == parent)
        {
            let id = item["id"].as_str().unwrap().to_string();
            result.push(id.clone());
            queue.push(id);
        }
    }
    result
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Actor {
    scope: Option<String>,
    grant_id: Option<String>,
}
fn view(data: &Value, scope: Option<&str>) -> Value {
    json!({"revision":data["revision"],"projects":data["projects"].as_array().unwrap().iter().filter(|p|scope.is_none_or(|s|p["id"]==s)).collect::<Vec<_>>(),"items":data["items"].as_array().unwrap().iter().filter(|p|scope.is_none_or(|s|p["projectId"]==s)).collect::<Vec<_>>()})
}
#[derive(Clone)]
pub struct TodoStore {
    file: PathBuf,
    prompts: Arc<Mutex<HashMap<String, (String, u64)>>>,
    delivery: preview_edits::EditService,
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}
impl TodoStore {
    pub fn new(file: PathBuf) -> Self {
        let directory = file.parent().unwrap().join("todo-delivery-receipts");
        Self {
            file,
            prompts: Arc::default(),
            delivery: preview_edits::EditService::new(directory),
        }
    }
    fn read(&self) -> Result<Value> {
        match fs::read(&self.file) {
            Ok(bytes) => {
                let data = serde_json::from_slice(&bytes).map_err(storage)?;
                checked(&data).map_err(storage)?;
                Ok(data)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(empty()),
            Err(e) => Err(storage(e)),
        }
    }
    fn actor(&self, data: &Value, bearer: Option<&str>, cookie: bool) -> Result<Actor> {
        if let Some(token) = bearer {
            if token.len() != 64
                || !token
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(fail(StatusCode::UNAUTHORIZED, "invalid_token"));
            }
            let checksum = hash(token.as_bytes());
            let grant = data["tokens"].as_array().unwrap().iter().find(|g| {
                g["hash"] == checksum
                    && g["revoked"] == false
                    && g["expiresAt"].as_u64().is_some_and(|t| t > now_millis())
            });
            let Some(grant) = grant else {
                return Err(fail(StatusCode::UNAUTHORIZED, "invalid_token"));
            };
            let scope = grant["projectId"].as_str().map(str::to_string);
            if scope.as_ref().is_some_and(|s| {
                !data["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["id"] == *s)
            }) {
                return Err(fail(StatusCode::UNAUTHORIZED, "invalid_token"));
            }
            return Ok(Actor {
                scope,
                grant_id: grant["id"].as_str().map(str::to_string),
            });
        }
        if !cookie {
            return Err(fail(StatusCode::UNAUTHORIZED, "authentication_required"));
        }
        Ok(Actor {
            scope: None,
            grant_id: None,
        })
    }
    fn write<T>(&self, action: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
        let parent = self.file.parent().unwrap();
        fs::create_dir_all(parent).map_err(storage)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(storage)?;
        let lock = parent.join("todos.lock");
        match fs::create_dir(&lock) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(fail(StatusCode::CONFLICT, "write_busy"))
            }
            Err(e) => return Err(storage(e)),
        };
        let _guard = Lock(lock);
        let mut data = self.read()?;
        let result = action(&mut data)?;
        checked(&data)?;
        let tmp = self.file.with_extension(format!("{}.tmp", id()));
        let saved = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(&serde_json::to_vec(&data)?)?;
            file.sync_all()?;
            fs::rename(&tmp, &self.file)?;
            fs::File::open(parent)?.sync_all()
        })();
        if saved.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        saved.map_err(storage)?;
        Ok(result)
    }
    fn query(&self, path: &[&str], bearer: Option<&str>, cookie: bool) -> Result<Value> {
        let data = self.read()?;
        let actor = self.actor(&data, bearer, cookie)?;
        let snapshot = view(&data, actor.scope.as_deref());
        if path.is_empty() {
            return Ok(snapshot);
        }
        if path == ["projects"] {
            return Ok(json!({"revision":data["revision"],"projects":snapshot["projects"]}));
        }
        let key = path.get(1).copied().unwrap_or("");
        let resource = path[0];
        let collection = if resource == "projects" {
            "projects"
        } else if resource == "items" {
            "items"
        } else {
            return Err(fail(StatusCode::NOT_FOUND, "not_found"));
        };
        let node = data[collection]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == key)
            .ok_or(fail(StatusCode::NOT_FOUND, "not_found"))?;
        let project = if resource == "projects" {
            &node["id"]
        } else {
            &node["projectId"]
        };
        if actor.scope.as_ref().is_some_and(|s| project != s) {
            return Err(fail(StatusCode::FORBIDDEN, "scope_forbidden"));
        }
        if resource == "projects" && path.len() == 3 && path[2] == "items" {
            return Ok(
                json!({"revision":data["revision"],"items":snapshot["items"].as_array().unwrap().iter().filter(|i|i["projectId"]==key).collect::<Vec<_>>()}),
            );
        }
        if path.len() != 2 {
            return Err(fail(StatusCode::NOT_FOUND, "not_found"));
        }
        let mut result = json!({"revision":data["revision"]});
        result[if resource == "projects" {
            "project"
        } else {
            "item"
        }] = node.clone();
        Ok(result)
    }
    fn mutate(
        &self,
        method: &str,
        path: &[&str],
        body: &Value,
        bearer: Option<&str>,
        cookie: bool,
    ) -> Result<Value> {
        self.write(|data| {
            let actor = self.actor(data, bearer, cookie)?;
            let checksum = hash(serde_json::to_string(&json!({"method":method,"path":path,"body":body,"actor":actor})).unwrap().as_bytes());
            let create = method == "POST";
            let request = body["requestId"].as_str().unwrap_or("");
            if create {
                if !valid_id(request) { return Err(invalid("invalid_request_id")); }
                if let Some(saved) = data["receipts"].get(request) {
                    if saved["digest"] != checksum { return Err(fail(StatusCode::CONFLICT, "request_conflict")); }
                    return Ok(saved["result"].clone());
                }
            }
            if body["revision"] != data["revision"] { return Err(fail(StatusCode::CONFLICT, "revision_conflict")); }
            let result = mutate_data(data, &actor, method, path, body)?;
            data["revision"] = json!(data["revision"].as_u64().unwrap() + 1);
            let reply = json!({"revision":data["revision"],"result":result,"snapshot":view(data,actor.scope.as_deref())});
            if create { data["receipts"][request] = json!({"digest":checksum,"result":reply}); }
            Ok(reply)
        })
    }
    fn grant(&self, scope: &Value, ttl: &Value) -> Result<Value> {
        let seconds = ttl
            .as_u64()
            .filter(|t| [3600, 28800, 86400].contains(t))
            .ok_or(invalid("invalid_expiry"))?;
        if !scope.is_null() && !scope.as_str().is_some_and(valid_id) {
            return Err(invalid("invalid_scope"));
        }
        let token = format!("{}{}", id(), id());
        let mut grant=self.write(|data| {if !scope.is_null() && !data["projects"].as_array().unwrap().iter().any(|p|p["id"]==*scope){return Err(fail(StatusCode::NOT_FOUND,"not_found"));}let g=json!({"id":id(),"hash":hash(token.as_bytes()),"projectId":scope,"expiresAt":now_millis()+seconds*1000,"revoked":false});data["tokens"].as_array_mut().unwrap().push(g.clone());data["revision"]=json!(data["revision"].as_u64().unwrap()+1);Ok(g)})?;
        grant.as_object_mut().unwrap().remove("hash");
        grant["token"] = json!(token);
        Ok(grant)
    }
}
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn mutate_data(
    data: &mut Value,
    actor: &Actor,
    method: &str,
    path: &[&str],
    body: &Value,
) -> Result<Value> {
    let resource = path.first().copied().unwrap_or("");
    let key = path.get(1).copied();
    let child = path.get(2).copied();
    let project = if resource == "projects" {
        data["projects"]
            .as_array()
            .unwrap()
            .iter()
            .position(|p| Some(p["id"].as_str().unwrap()) == key)
    } else {
        None
    };
    let item = if resource == "items" {
        data["items"]
            .as_array()
            .unwrap()
            .iter()
            .position(|p| Some(p["id"].as_str().unwrap()) == key)
    } else {
        None
    };
    if key.is_some() && project.is_none() && item.is_none() {
        return Err(fail(StatusCode::NOT_FOUND, "not_found"));
    }
    let scope = item
        .map(|i| data["items"][i]["projectId"].as_str().unwrap())
        .or_else(|| project.map(|i| data["projects"][i]["id"].as_str().unwrap()));
    if actor.scope.as_deref().is_some_and(|s| Some(s) != scope) {
        return Err(fail(StatusCode::FORBIDDEN, "scope_forbidden"));
    }
    let create_project = resource == "projects" && key.is_none() && method == "POST";
    let create_item = project.is_some() && child == Some("items") && method == "POST";
    let mut allowed = vec!["revision"];
    if create_project || create_item {
        allowed.push("requestId");
    }
    if method == "DELETE" {
        allowed.push("recursive");
    } else {
        allowed.extend(["title", "description", "order"]);
        if create_item {
            allowed.extend(["kind", "parentId", "status"]);
        } else if item.is_some() {
            allowed.extend(["projectId", "parentId", "status"]);
        }
    }
    if body
        .as_object()
        .unwrap()
        .keys()
        .any(|k| !allowed.contains(&k.as_str()))
    {
        return Err(invalid("unknown_field"));
    }
    for (field, max, required) in [("title", 160, true), ("description", 8000, false)] {
        if body.get(field).is_some_and(|v| !text(v, max, required)) {
            return Err(invalid("invalid_node"));
        }
    }
    if body.get("order").is_some_and(|v| !number(v)) {
        return Err(invalid("invalid_node"));
    }
    let revision = data["revision"].as_u64().unwrap() + 1;
    if create_project || create_item {
        if !text(&body["title"], 160, true) {
            return Err(invalid("invalid_title"));
        }
        let mut node = json!({"id":id(),"title":body["title"].as_str().unwrap().trim(),"description":body.get("description").cloned().unwrap_or(json!("")),"order":body.get("order").cloned().unwrap_or(json!(if create_project{data["projects"].as_array().unwrap().len()}else{data["items"].as_array().unwrap().len()})),"revision":revision});
        if create_item {
            let kind = body["kind"].as_str().unwrap_or("");
            if !matches!(kind, "folder" | "task") {
                return Err(invalid("invalid_node"));
            }
            if kind == "folder" && !body["status"].is_null() {
                return Err(invalid("folder_has_no_status"));
            }
            node["projectId"] = data["projects"][project.unwrap()]["id"].clone();
            node["parentId"] = body.get("parentId").cloned().unwrap_or(Value::Null);
            node["kind"] = json!(kind);
            node["status"] = if kind == "folder" {
                Value::Null
            } else {
                body.get("status").cloned().unwrap_or(json!("todo"))
            };
        }
        data[if create_project { "projects" } else { "items" }]
            .as_array_mut()
            .unwrap()
            .push(node.clone());
        checked(data)?;
        return Ok(node);
    }
    if child.is_some() || !matches!(method, "PATCH" | "DELETE") {
        return Err(fail(StatusCode::NOT_FOUND, "not_found"));
    }
    let collection = if item.is_some() { "items" } else { "projects" };
    let index = item
        .or(project)
        .ok_or(fail(StatusCode::NOT_FOUND, "not_found"))?;
    let node_id = data[collection][index]["id"].as_str().unwrap().to_string();
    if method == "DELETE" {
        let mut removed = if item.is_some() {
            descendants(data, &node_id)
        } else {
            data["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|i| i["projectId"] == node_id)
                .map(|i| i["id"].as_str().unwrap().to_string())
                .collect()
        };
        if !removed.is_empty() && body["recursive"] != true {
            return Err(fail(StatusCode::CONFLICT, "confirmation_required"));
        }
        if item.is_some() {
            removed.push(node_id.clone());
        }
        data["items"]
            .as_array_mut()
            .unwrap()
            .retain(|i| !removed.contains(&i["id"].as_str().unwrap().to_string()));
        if project.is_some() {
            data["projects"].as_array_mut().unwrap().remove(index);
        }
        return Ok(json!({"deleted":node_id,"count":removed.len()}));
    }
    if let Some(index) = item {
        if body.get("status").is_some_and(|v| {
            data["items"][index]["kind"] != "task" || !STATES.contains(&v.as_str().unwrap_or(""))
        }) {
            return Err(invalid("invalid_status"));
        }
        if body
            .get("parentId")
            .is_some_and(|v| !v.is_null() && !v.as_str().is_some_and(valid_id))
        {
            return Err(invalid("invalid_parent"));
        }
        if let Some(project_id) = body.get("projectId") {
            if !data["projects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["id"] == *project_id)
            {
                return Err(invalid("invalid_project"));
            }
            if actor.scope.as_ref().is_some_and(|s| project_id != s) {
                return Err(fail(StatusCode::FORBIDDEN, "scope_forbidden"));
            }
            if data["items"][index]["projectId"] != *project_id {
                let children = descendants(data, &node_id);
                for node in data["items"].as_array_mut().unwrap() {
                    if children.contains(&node["id"].as_str().unwrap().to_string()) {
                        node["projectId"] = project_id.clone();
                        node["revision"] = json!(revision);
                    }
                }
                data["items"][index]["projectId"] = project_id.clone();
                data["items"][index]["parentId"] = Value::Null;
            }
        }
        for field in ["parentId", "status"] {
            if let Some(value) = body.get(field) {
                data["items"][index][field] = value.clone();
            }
        }
    }
    for field in ["title", "description", "order"] {
        if let Some(value) = body.get(field) {
            data[collection][index][field] = if field == "title" {
                json!(value.as_str().unwrap().trim())
            } else {
                value.clone()
            };
        }
    }
    data[collection][index]["revision"] = json!(revision);
    checked(data)?;
    Ok(data[collection][index].clone())
}

fn prompt(base: &str, token: &str, scope: &Value, expires: u64, snapshot: &Value) -> String {
    let scope = scope.as_str().unwrap_or("全清单（用户明确授权）");
    format!("请根据当前工作真实进展维护 Shelt 待办。先查询，再复用已有项目和任务更新；无证据保留原状态，描述依据。不得将收到本提示词当作完成证据。\n\nAPI 根地址：{base}/api/todos；授权范围：{scope}；到期时间Unix毫秒：{expires}。不可达时报告，不自行建隧道。\n\n仅任务叶子有 todo/doing/blocked/done/canceled 状态；folder 的 status=null。父级汇总。支持重开、取消及恢复。PATCH/DELETE带最新revision；409重新读取。POST用32位小写hex requestId，重试沿用。非空删除需用户明确要求并传recursive:true。\n\n临时令牌仅用于 Authorization 头，不写URL、日志、文件、提交或最终答复。HTTP仅适用于受信内网，公网用HTTPS。\n\nexport SHELT_TODO_BASE={base:?}\nexport SHELT_TODO_TOKEN={token:?}\n\ncurl -fsS \"$SHELT_TODO_BASE/api/todos\" -H \"Authorization: Bearer $SHELT_TODO_TOKEN\"\n\ncurl -fsS \"$SHELT_TODO_BASE/api/todos/projects\" -H \"Authorization: Bearer $SHELT_TODO_TOKEN\"\n\n写操作带 -H \"Content-Type: application/json\" -H \"Authorization: Bearer $SHELT_TODO_TOKEN\"。\nGET /api/todos/projects/{{id}}；GET /api/todos/projects/{{id}}/items；GET /api/todos/items/{{id}}。\nPOST /api/todos/projects {{\"revision\":0,\"requestId\":\"<32hex>\",\"title\":\"项目\"}}（仅全清单可创建）\nPOST /api/todos/projects/{{id}}/items {{\"revision\":0,\"requestId\":\"<32hex>\",\"kind\":\"task\",\"parentId\":null,\"title\":\"任务\",\"status\":\"todo\"}}；同路径用kind=folder创建清单。\nPATCH /api/todos/projects/{{id}} {{\"revision\":1,\"title\":\"项目名称\"}}\nPATCH /api/todos/items/{{id}} {{\"revision\":2,\"status\":\"doing\",\"description\":\"进展依据\"}}；parentId/projectId/order用于移动排序。\nDELETE /api/todos/projects/{{id}} 或 /api/todos/items/{{id}} {{\"revision\":3,\"recursive\":true}}\n\n快照只作参考，执行前先GET：\n{}",serde_json::to_string_pretty(snapshot).unwrap())
}
fn response(value: Value, code: StatusCode) -> Response {
    let mut r = secure((code, Json(value)).into_response());
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}
async fn handle_inner(
    state: AppState,
    headers: HeaderMap,
    uri: Uri,
    method: axum::http::Method,
    body: Bytes,
) -> Result<Response> {
    if !allowed_host(&state, &headers) {
        return Err(fail(StatusCode::FORBIDDEN, "forbidden"));
    }
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let bearer = auth_header.map(|s| s.strip_prefix("Bearer ").unwrap_or(""));
    let cookie = authenticated(&state, &headers);
    let path = uri
        .path()
        .strip_prefix("/api/todos")
        .unwrap_or("")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let management = path
        .first()
        .is_some_and(|p| ["grants", "prompt", "agents", "send"].contains(p));
    if management && (bearer.is_some() || !cookie) {
        return Err(fail(
            if bearer.is_some() {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::UNAUTHORIZED
            },
            "browser_only",
        ));
    }
    if method != axum::http::Method::GET
        && (bearer.is_none() || headers.contains_key(header::ORIGIN))
        && !allowed_origin(&state, &headers)
    {
        return Err(fail(StatusCode::FORBIDDEN, "forbidden_origin"));
    }
    let store = &state.todos;
    let data = store.read()?;
    let actor = store.actor(&data, bearer, cookie)?;
    if path == ["events"] && method == axum::http::Method::GET {
        let bearer = bearer.map(str::to_string);
        let headers = headers.clone();
        let state = state.clone();
        let stream = futures_util::stream::unfold(
            (state, headers, bearer, None),
            |(state, headers, bearer, last)| async move {
                let mut last = last;
                loop {
                    if last.is_some() {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    let data = state.todos.read().ok()?;
                    let actor = state
                        .todos
                        .actor(&data, bearer.as_deref(), authenticated(&state, &headers))
                        .ok()?;
                    let revision = data["revision"].as_u64()?;
                    if last != Some(revision) {
                        last = Some(revision);
                        let event = Ok::<_, std::convert::Infallible>(
                            axum::response::sse::Event::default()
                                .event("snapshot")
                                .json_data(view(&data, actor.scope.as_deref()))
                                .ok()?,
                        );
                        return Some((event, (state, headers, bearer, last)));
                    }
                }
            },
        );
        return Ok(axum::response::sse::Sse::new(stream)
            .keep_alive(axum::response::sse::KeepAlive::new().interval(Duration::from_secs(20)))
            .into_response());
    }
    let body: Value = if method == axum::http::Method::GET {
        json!({})
    } else {
        if body.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&body).map_err(|_| invalid("invalid_body"))?
        }
    };
    if !body.is_object() {
        return Err(invalid("invalid_body"));
    }
    if path == ["agents"] && method == axum::http::Method::GET {
        let (active, targets) = state.targets.list();
        let target = targets.iter().find(|t| t.id == active);
        let mut agents = Vec::new();
        for target in std::iter::once(None).chain(targets.iter().map(Some)) {
            if let Ok(list) = preview_edits::named_agents(&state.launch, target).await {
                agents.extend(list.into_iter().map(|a| serde_json::to_value(a).unwrap()));
            }
        }
        let focused = preview_edits::command(&state.launch, target, &["pane", "current"], None)
            .await
            .ok()
            .and_then(|v| v["pane"]["pane_id"].as_str().map(str::to_string));
        let source = agents
            .iter()
            .find(|a| a["paneId"].as_str() == focused.as_deref() && a["targetId"] == active)
            .cloned();
        return Ok(response(
            json!({"agents":agents,"source":source}),
            StatusCode::OK,
        ));
    }
    if path == ["grants"] && method == axum::http::Method::GET {
        let grants = data["tokens"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| {
                let mut g = g.clone();
                g.as_object_mut().unwrap().remove("hash");
                g
            })
            .collect::<Vec<_>>();
        return Ok(response(json!({"grants":grants}), StatusCode::OK));
    }
    if path == ["grants"] && method == axum::http::Method::POST {
        if body.get("projectId").is_none() {
            return Err(invalid("invalid_scope"));
        }
        return Ok(response(
            store.grant(&body["projectId"], &body["ttlSeconds"])?,
            StatusCode::OK,
        ));
    }
    if path.first() == Some(&"grants") && path.len() == 2 && method == axum::http::Method::DELETE {
        store.prompts.lock().unwrap().remove(path[1]);
        let result = store.write(|data| {
            let grant = data["tokens"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|g| g["id"] == path[1])
                .ok_or(fail(StatusCode::NOT_FOUND, "not_found"))?;
            grant["revoked"] = json!(true);
            data["revision"] = json!(data["revision"].as_u64().unwrap() + 1);
            Ok(json!({"revoked":true}))
        })?;
        return Ok(response(result, StatusCode::OK));
    }
    if path == ["prompt"] && method == axum::http::Method::POST {
        if body.get("projectId").is_none() {
            return Err(invalid("invalid_scope"));
        }
        let base = reqwest::Url::parse(body["baseUrl"].as_str().unwrap_or(""))
            .map_err(|_| invalid("invalid_base_url"))?;
        let authority = base
            .host_str()
            .map(|h| {
                format!(
                    "{}{}",
                    h,
                    base.port().map(|p| format!(":{p}")).unwrap_or_default()
                )
            })
            .unwrap_or_default();
        if !matches!(base.scheme(), "http" | "https")
            || !base.username().is_empty()
            || base.password().is_some()
            || base.path() != "/"
            || base.query().is_some()
            || base.fragment().is_some()
            || !state.public_hosts.contains(&authority.to_lowercase())
        {
            return Err(invalid("invalid_base_url"));
        }
        let grant = store.grant(&body["projectId"], &body["ttlSeconds"])?;
        let expires = grant["expiresAt"].as_u64().unwrap();
        let scope = grant["projectId"].as_str();
        let prompt = prompt(
            base.origin().ascii_serialization().as_str(),
            grant["token"].as_str().unwrap(),
            &grant["projectId"],
            expires,
            &view(&store.read()?, scope),
        );
        if prompt.len() > 60 * 1024 {
            store.write(|data| {
                for g in data["tokens"].as_array_mut().unwrap() {
                    if g["id"] == grant["id"] {
                        g["revoked"] = json!(true);
                    }
                }
                data["revision"] = json!(data["revision"].as_u64().unwrap() + 1);
                Ok(())
            })?;
            return Err(fail(StatusCode::PAYLOAD_TOO_LARGE, "too_large"));
        }
        {
            let mut prompts = store.prompts.lock().unwrap();
            prompts.retain(|_, (_, t)| *t > now_millis());
            prompts.insert(
                grant["id"].as_str().unwrap().to_string(),
                (prompt.clone(), expires),
            );
        }
        return Ok(response(
            json!({"grantId":grant["id"],"projectId":grant["projectId"],"expiresAt":expires,"prompt":prompt}),
            StatusCode::OK,
        ));
    }
    if path == ["send"] && method == axum::http::Method::POST {
        if !body["requestId"].as_str().is_some_and(valid_id)
            || !body["grantId"].as_str().is_some_and(valid_id)
            || !body["session"].as_str().is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            || !body["paneId"].as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b":._-".contains(&b))
            })
        {
            return Err(invalid("invalid_request"));
        }
        let grant = data["tokens"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| {
                g["id"] == body["grantId"]
                    && g["revoked"] == false
                    && g["expiresAt"].as_u64().is_some_and(|t| t > now_millis())
            })
            .ok_or(fail(StatusCode::GONE, "regenerate_prompt"))?;
        let prompt = store
            .prompts
            .lock()
            .unwrap()
            .get(grant["id"].as_str().unwrap())
            .cloned()
            .filter(|(_, t)| *t > now_millis())
            .ok_or(fail(StatusCode::GONE, "regenerate_prompt"))?
            .0;
        let targets = state.targets.list().1;
        let target = targets
            .iter()
            .find(|t| Some(t.id.as_str()) == body["targetId"].as_str());
        if body["targetId"] != "local" && target.is_none() {
            return Err(fail(StatusCode::NOT_FOUND, "unavailable"));
        }
        let result = store
            .delivery
            .send_text(&state, &body, target, &prompt)
            .await
            .map_err(storage)?;
        let code = if result.get("error").is_some() {
            StatusCode::CONFLICT
        } else {
            StatusCode::OK
        };
        return Ok(response(result, code));
    }
    let result = if method == axum::http::Method::GET {
        store.query(&path, bearer, cookie)?
    } else if ["POST", "PATCH", "DELETE"].contains(&method.as_str())
        && path
            .first()
            .is_some_and(|p| ["projects", "items"].contains(p))
        && path.len() <= 3
    {
        store.mutate(method.as_str(), &path, &body, bearer, cookie)?
    } else {
        return Err(fail(StatusCode::NOT_FOUND, "not_found"));
    };
    let _ = actor;
    Ok(response(result, StatusCode::OK))
}
pub async fn handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    method: axum::http::Method,
    body: Bytes,
) -> Response {
    match handle_inner(state, headers, uri, method, body).await {
        Ok(r) => r,
        Err((status, code)) => response(json!({"error":code}), status),
    }
}
