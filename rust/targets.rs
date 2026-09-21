use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub const LOCAL_TARGET_ID: &str = "local";
const MAX_TARGETS: usize = 16;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrTarget {
    pub id: String,
    pub name: String,
    pub remote: String,
    pub session: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetsFile {
    active: String,
    targets: Vec<HerdrTarget>,
}

#[derive(Clone)]
pub struct TargetStore {
    file: PathBuf,
    state: Arc<Mutex<TargetsFile>>,
}

fn valid_remote(remote: &str) -> bool {
    if remote.starts_with('-') {
        return false;
    }
    let (user, host) = match remote.split_once('@') {
        Some((user, host)) => (Some(user), host),
        None => (None, remote),
    };
    let valid_user = user.is_none_or(|value| {
        (1..=64).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'%' | b'+' | b'-'))
    });
    let valid_host = (1..=253).contains(&host.len())
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
    valid_user && valid_host
}

fn valid_session(session: &str) -> bool {
    (1..=64).contains(&session.len())
        && session
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub fn target_error(name: &str, remote: &str, session: Option<&str>) -> Option<&'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 40 || trimmed.chars().any(|c| c.is_control())
    {
        return Some("名称需要 1-40 个字符");
    }
    if !valid_remote(remote) {
        return Some("SSH 目标格式无效");
    }
    if session.is_some_and(|value| !valid_session(value)) {
        return Some("会话名格式无效");
    }
    None
}

fn valid_entry(entry: &HerdrTarget) -> bool {
    entry.id.len() == 8
        && entry.id.bytes().all(|b| b.is_ascii_hexdigit())
        && target_error(&entry.name, &entry.remote, entry.session.as_deref()).is_none()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl TargetStore {
    pub fn load(file: PathBuf) -> io::Result<Self> {
        let mut state: TargetsFile = match fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => TargetsFile {
                active: LOCAL_TARGET_ID.into(),
                targets: Vec::new(),
            },
            Err(error) => return Err(error),
        };
        if state.targets.iter().any(|entry| !valid_entry(entry)) {
            return Err(io::Error::other("Invalid Herdr target records"));
        }
        if state.active != LOCAL_TARGET_ID && !state.targets.iter().any(|t| t.id == state.active) {
            state.active = LOCAL_TARGET_ID.into();
        }
        Ok(Self {
            file,
            state: Arc::new(Mutex::new(state)),
        })
    }

    fn save(&self, state: &TargetsFile) -> io::Result<()> {
        let parent = self
            .file
            .parent()
            .ok_or_else(|| io::Error::other("Missing state directory"))?;
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        let mut random = [0u8; 16];
        OsRng.fill_bytes(&mut random);
        let temporary = parent.join(format!(".targets-{}.tmp", hex(&random)));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&serde_json::to_vec(state).map_err(io::Error::other)?)?;
            file.sync_all()?;
            fs::rename(&temporary, &self.file)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    pub fn list(&self) -> (String, Vec<HerdrTarget>) {
        let guard = self.state.lock().unwrap();
        (guard.active.clone(), guard.targets.clone())
    }

    pub fn create(
        &self,
        name: &str,
        remote: &str,
        session: Option<String>,
    ) -> io::Result<HerdrTarget> {
        let mut random = [0u8; 4];
        OsRng.fill_bytes(&mut random);
        let entry = HerdrTarget {
            id: hex(&random),
            name: name.trim().to_string(),
            remote: remote.to_string(),
            session,
        };
        let mut guard = self.state.lock().unwrap();
        if guard.targets.len() >= MAX_TARGETS {
            return Err(io::Error::other("最多配置 16 个远程连接"));
        }
        guard.targets.push(entry.clone());
        self.save(&guard)?;
        Ok(entry)
    }

    pub fn update(
        &self,
        id: &str,
        name: &str,
        remote: &str,
        session: Option<String>,
    ) -> io::Result<Option<HerdrTarget>> {
        let mut guard = self.state.lock().unwrap();
        let Some(entry) = guard
            .targets
            .iter_mut()
            .find(|candidate| candidate.id == id)
        else {
            return Ok(None);
        };
        entry.name = name.trim().to_string();
        entry.remote = remote.to_string();
        entry.session = session;
        let updated = entry.clone();
        self.save(&guard)?;
        Ok(Some(updated))
    }

    pub fn remove(&self, id: &str) -> io::Result<bool> {
        let mut guard = self.state.lock().unwrap();
        let before = guard.targets.len();
        guard.targets.retain(|entry| entry.id != id);
        if guard.targets.len() == before {
            return Ok(false);
        }
        if guard.active == id {
            guard.active = LOCAL_TARGET_ID.into();
        }
        self.save(&guard)?;
        Ok(true)
    }

    pub fn activate(&self, id: &str) -> io::Result<bool> {
        let mut guard = self.state.lock().unwrap();
        if id != LOCAL_TARGET_ID && !guard.targets.iter().any(|entry| entry.id == id) {
            return Ok(false);
        }
        guard.active = id.to_string();
        self.save(&guard)?;
        Ok(true)
    }

    pub fn active_args(&self) -> Vec<String> {
        let guard = self.state.lock().unwrap();
        let Some(entry) = guard.targets.iter().find(|t| t.id == guard.active) else {
            return Vec::new();
        };
        let mut args = vec!["--remote".to_string(), entry.remote.clone()];
        if let Some(session) = &entry.session {
            args.push("--session".to_string());
            args.push(session.clone());
        }
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_store() -> (TargetStore, PathBuf) {
        let mut nonce = [0u8; 8];
        OsRng.fill_bytes(&mut nonce);
        let directory = std::env::temp_dir().join(format!(
            "shelt-targets-test-{}-{}",
            std::process::id(),
            hex(&nonce)
        ));
        let file = directory.join("herdr-targets.json");
        (TargetStore::load(file).unwrap(), directory)
    }

    #[test]
    fn validates_targets() {
        assert!(target_error("开发机", "dev@10.0.0.2", None).is_none());
        assert!(target_error("home", "example.com", Some("work-1")).is_none());
        assert!(target_error("", "example.com", None).is_some());
        assert!(target_error("x", "-oProxyCommand=evil", None).is_some());
        assert!(target_error("x", "host; rm -rf /", None).is_some());
        assert!(target_error("x", "user@host", Some("-bad")).is_some());
        assert!(target_error("x", "user@host", Some("has space")).is_some());
    }

    #[test]
    fn lifecycle_persists_and_tracks_active_args() {
        let (store, directory) = temporary_store();
        let file = directory.join("herdr-targets.json");
        assert_eq!(store.active_args(), Vec::<String>::new());
        let created = store.create("开发机", "dev@10.0.0.2", None).unwrap();
        assert!(store.activate(&created.id).unwrap());
        assert_eq!(store.active_args(), vec!["--remote", "dev@10.0.0.2"]);
        let updated = store
            .update(&created.id, "开发机", "dev@10.0.0.2", Some("work".into()))
            .unwrap()
            .unwrap();
        assert_eq!(updated.session.as_deref(), Some("work"));
        let loaded = TargetStore::load(file.clone()).unwrap();
        assert_eq!(
            loaded.active_args(),
            vec!["--remote", "dev@10.0.0.2", "--session", "work"]
        );
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!loaded.activate("ffffffff").unwrap());
        assert!(loaded.remove(&created.id).unwrap());
        assert_eq!(loaded.list().0, LOCAL_TARGET_ID);
        assert!(loaded.active_args().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
}
