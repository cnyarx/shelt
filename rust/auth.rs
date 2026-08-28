use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

pub const SESSION_COOKIE: &str = "shelt_session";
pub const REMEMBER_SECONDS: u64 = 30 * 24 * 60 * 60;
pub const MAX_AUTH_BODY_BYTES: usize = 8 * 1024;
const VOLATILE_SESSION_SECONDS: u64 = 24 * 60 * 60;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthFile {
    version: u8,
    password_hash: String,
    created_at: String,
}

#[derive(Clone)]
pub struct AuthStore {
    file_path: PathBuf,
    secure_cookie: bool,
    password_hash: Arc<Mutex<Option<String>>>,
    sessions: Arc<Mutex<HashMap<String, SystemTime>>>,
}

impl AuthStore {
    pub fn load(
        file_path: PathBuf,
        secure_cookie: bool,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let password_hash = match fs::read_to_string(&file_path) {
            Ok(content) => {
                let parsed: AuthFile = serde_json::from_str(&content)?;
                if parsed.version != 1 || !parsed.password_hash.starts_with("$argon2id$") {
                    return Err(
                        format!("Invalid authentication file: {}", file_path.display()).into(),
                    );
                }
                PasswordHash::new(&parsed.password_hash)
                    .map_err(|error| format!("Invalid password hash: {error}"))?;
                Some(parsed.password_hash)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            file_path,
            secure_cookie,
            password_hash: Arc::new(Mutex::new(password_hash)),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn setup_required(&self) -> bool {
        self.password_hash.lock().unwrap().is_none()
    }

    pub fn setup(&self, password: &str) -> Result<bool, Box<dyn std::error::Error>> {
        if !self.setup_required() {
            return Ok(false);
        }
        let params = Params::new(19456, 2, 1, None)
            .map_err(|error| format!("Invalid Argon2 parameters: {error}"))?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let salt = SaltString::generate(&mut OsRng);
        let password_hash = argon2
            .hash_password(password.as_bytes(), &salt)
            .map_err(|error| format!("Unable to hash password: {error}"))?
            .to_string();
        let parent = self.file_path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        let mut file = match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&self.file_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let data = AuthFile {
            version: 1,
            password_hash: password_hash.clone(),
            created_at: unix_timestamp().to_string(),
        };
        file.write_all(serde_json::to_string(&data)?.as_bytes())?;
        file.write_all(b"\n")?;
        fs::set_permissions(&self.file_path, fs::Permissions::from_mode(0o600))?;
        *self.password_hash.lock().unwrap() = Some(password_hash);
        Ok(true)
    }

    pub fn verify(&self, password: &str) -> bool {
        let guard = self.password_hash.lock().unwrap();
        let Some(encoded) = guard.as_deref() else {
            return false;
        };
        let Ok(hash) = PasswordHash::new(encoded) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    }

    pub fn create_session(&self, remember: bool) -> String {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let lifetime = Duration::from_secs(if remember {
            REMEMBER_SECONDS
        } else {
            VOLATILE_SESSION_SECONDS
        });
        let now = SystemTime::now();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, expires| *expires > now);
        sessions.insert(token.clone(), now + lifetime);
        token
    }

    pub fn authenticated(&self, cookie: Option<&str>) -> bool {
        let Some(token) = cookie.and_then(|value| parse_cookie(value, SESSION_COOKIE)) else {
            return false;
        };
        let now = SystemTime::now();
        let mut sessions = self.sessions.lock().unwrap();
        let valid = sessions.get(token).is_some_and(|expires| *expires > now);
        if !valid {
            sessions.remove(token);
        }
        valid
    }

    pub fn revoke(&self, cookie: Option<&str>) {
        if let Some(token) = cookie.and_then(|value| parse_cookie(value, SESSION_COOKIE)) {
            self.sessions.lock().unwrap().remove(token);
        }
    }

    pub fn session_cookie(&self, token: &str, remember: bool) -> String {
        let mut cookie = format!("{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/");
        if remember {
            cookie.push_str(&format!("; Max-Age={REMEMBER_SECONDS}"));
        }
        if self.secure_cookie {
            cookie.push_str("; Secure");
        }
        cookie
    }

    pub fn expired_cookie(&self) -> String {
        let mut cookie = format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        if self.secure_cookie {
            cookie.push_str("; Secure");
        }
        cookie
    }
}

pub fn password_error(password: &str) -> Option<&'static str> {
    let length = password.chars().count();
    if length < 8 {
        Some("Password must be at least 8 characters")
    } else if length > 256 {
        Some("Password must be at most 256 characters")
    } else {
        None
    }
}

pub fn parse_cookie<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|item| {
        let (key, value) = item.trim().split_once('=')?;
        (key == name && !value.is_empty()).then_some(value)
    })
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_auth() -> (AuthStore, PathBuf) {
        let mut nonce = [0u8; 8];
        OsRng.fill_bytes(&mut nonce);
        let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("shelt-auth-{}-{suffix}", std::process::id()));
        let file = path.join("state/auth.json");
        (AuthStore::load(file, false).unwrap(), path)
    }

    #[test]
    fn validates_password_length_by_characters() {
        assert!(password_error("1234567").is_some());
        assert!(password_error("密码密码密码密码").is_none());
    }

    #[test]
    fn persists_private_argon2_hash_and_reloads_password() {
        let (store, directory) = temporary_auth();
        assert!(store.setup_required());
        assert!(store.setup("correct horse battery staple").unwrap());
        assert!(!store.setup("replacement password").unwrap());
        assert!(store.verify("correct horse battery staple"));
        assert!(!store.verify("wrong password"));
        let file = directory.join("state/auth.json");
        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("$argon2id$"));
        assert!(!content.contains("correct horse battery staple"));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(file.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let token = store.create_session(true);
        let cookie = format!("{SESSION_COOKIE}={token}");
        assert!(store.authenticated(Some(&cookie)));
        let restarted = AuthStore::load(file, false).unwrap();
        assert!(restarted.verify("correct horse battery staple"));
        assert!(!restarted.authenticated(Some(&cookie)));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn creates_private_remembered_cookie_and_revokes_session() {
        let (store, directory) = temporary_auth();
        let token = store.create_session(true);
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let cookie = store.session_cookie(&token, true);
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains(&format!("Max-Age={REMEMBER_SECONDS}")));
        assert!(store.authenticated(Some(&cookie)));
        store.revoke(Some(&cookie));
        assert!(!store.authenticated(Some(&cookie)));
        assert!(store.expired_cookie().contains("Max-Age=0"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn parses_cookie_without_prefix_collisions() {
        assert_eq!(
            parse_cookie("other=1; shelt_session=abc", SESSION_COOKIE),
            Some("abc")
        );
        assert_eq!(parse_cookie("not_shelt_session=abc", SESSION_COOKIE), None);
    }
}
