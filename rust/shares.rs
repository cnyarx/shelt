use rand_core::{OsRng, RngCore};
use ring::digest::{digest, SHA256};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub const LIFETIME: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub hash: String,
    pub path: PathBuf,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct ShareStore {
    file: PathBuf,
    entries: Arc<Mutex<Vec<Share>>>,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn token_hash(token: &str) -> Option<String> {
    if token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    Some(hex(digest(&SHA256, token.as_bytes()).as_ref()))
}

impl ShareStore {
    pub fn load(file: PathBuf) -> io::Result<Self> {
        let entries = match fs::read(&file) {
            Ok(bytes) => serde_json::from_slice::<Vec<Share>>(&bytes).map_err(io::Error::other)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        if entries
            .iter()
            .any(|entry| !entry.path.is_absolute() || token_hash(&entry.hash).is_none())
        {
            return Err(io::Error::other("Invalid share records"));
        }
        Ok(Self {
            file,
            entries: Arc::new(Mutex::new(entries)),
        })
    }

    fn save(&self, entries: &[Share]) -> io::Result<()> {
        let parent = self
            .file
            .parent()
            .ok_or_else(|| io::Error::other("Missing state directory"))?;
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        let mut random = [0u8; 16];
        OsRng.fill_bytes(&mut random);
        let temporary = parent.join(format!(".shares-{}.tmp", hex(&random)));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&serde_json::to_vec(entries).map_err(io::Error::other)?)?;
            file.sync_all()?;
            fs::rename(&temporary, &self.file)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    pub fn create(&self, path: PathBuf) -> io::Result<(String, u64)> {
        let mut random = [0u8; 32];
        OsRng.fill_bytes(&mut random);
        let token = hex(&random);
        let expires_at = now() + LIFETIME;
        let mut guard = self.entries.lock().unwrap();
        let mut entries: Vec<_> = guard
            .iter()
            .filter(|s| s.path != path && s.expires_at > now())
            .cloned()
            .collect();
        entries.push(Share {
            hash: token_hash(&token).unwrap(),
            path,
            expires_at,
        });
        self.save(&entries)?;
        *guard = entries;
        Ok((token, expires_at))
    }

    pub fn revoke(&self, path: &PathBuf) -> io::Result<()> {
        let mut guard = self.entries.lock().unwrap();
        let entries: Vec<_> = guard
            .iter()
            .filter(|s| &s.path != path && s.expires_at > now())
            .cloned()
            .collect();
        self.save(&entries)?;
        *guard = entries;
        Ok(())
    }

    pub fn status(&self, path: &PathBuf) -> Option<u64> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|s| &s.path == path && s.expires_at > now())
            .map(|s| s.expires_at)
    }

    pub fn resolve(&self, token: &str) -> Option<Share> {
        let hash = token_hash(token)?;
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.hash == hash && s.expires_at > now())
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_and_private_persistence() {
        let directory =
            std::env::temp_dir().join(format!("shelt-share-test-{}-{}", std::process::id(), now()));
        let file = directory.join("shares.json");
        let store = ShareStore::load(file.clone()).unwrap();
        let path = PathBuf::from("/document.md");
        let (first, expiry) = store.create(path.clone()).unwrap();
        assert!(expiry > now());
        assert_eq!(store.resolve(&first).unwrap().path, path);
        assert!(!fs::read_to_string(&file).unwrap().contains(&first));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let loaded = ShareStore::load(file.clone()).unwrap();
        assert!(loaded.resolve(&first).is_some());
        let (second, _) = loaded.create(path.clone()).unwrap();
        assert!(loaded.resolve(&first).is_none());
        assert!(loaded.resolve(&second).is_some());
        assert!(loaded.resolve("../invalid").is_none());
        loaded.entries.lock().unwrap()[0].expires_at = now() - 1;
        assert!(loaded.resolve(&second).is_none());
        let (third, _) = loaded.create(path.clone()).unwrap();
        loaded.revoke(&path).unwrap();
        assert!(ShareStore::load(file).unwrap().resolve(&third).is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
