use super::*;
use rand_core::{OsRng, RngCore};
use ring::digest::SHA256;
use std::{
    ffi::CString,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use tokio::io::AsyncWriteExt;

const LATEST_URL: &str = "https://api.github.com/repos/cnyarx/shelt/releases/latest";
const RELEASE_ROOT: &str = "https://github.com/cnyarx/shelt/releases/download";
const MAX_BINARY: u64 = 128 * 1024 * 1024;
const CHECK_INTERVAL: Duration = Duration::from_secs(3600);
const ERROR_INTERVAL: Duration = Duration::from_secs(300);

type UpdateResult<T> = Result<T, String>;

#[derive(Clone, Deserialize, Serialize)]
pub struct BuildInfo {
    pub version: String,
    pub commit: String,
    pub dirty: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct Asset {
    name: String,
    size: u64,
    state: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Clone, Debug)]
struct Release {
    version: String,
    binary: Asset,
    checksum: Asset,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    latest_version: Option<String>,
    available: bool,
    can_install: bool,
    reason: Option<&'static str>,
    phase: &'static str,
    error: Option<String>,
}

struct Cached {
    at: Instant,
    result: UpdateResult<Release>,
}

#[derive(Clone)]
pub struct Updater(Arc<Inner>);
struct Inner {
    build: BuildInfo,
    executable: PathBuf,
    client: reqwest::Client,
    latest_url: String,
    release_root: String,
    cache: tokio::sync::Mutex<Option<Cached>>,
    phase: Mutex<(&'static str, Option<String>)>,
    installing: AtomicBool,
    restarting: AtomicBool,
    pending: Mutex<Option<Installation>>,
    restart: tokio::sync::Notify,
}

pub fn version_number(value: &str) -> Option<[u64; 3]> {
    let numbers: Vec<_> = value.strip_prefix('v')?.split('.').collect();
    if numbers.len() != 3 {
        return None;
    }
    let mut version = [0; 3];
    for (index, part) in numbers.iter().enumerate() {
        if part.is_empty()
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        version[index] = part.parse().ok()?;
    }
    Some(version)
}

fn asset_name() -> Option<&'static str> {
    match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => Some("shelt-linux-x86_64-musl"),
        ("macos", "aarch64") => Some("shelt-macos-aarch64"),
        _ => None,
    }
}

fn release_from_json(bytes: &[u8], name: &str, root: &str) -> UpdateResult<Release> {
    let release: GithubRelease =
        serde_json::from_slice(bytes).map_err(|_| "updateInvalidRelease")?;
    if release.draft || release.prerelease || version_number(&release.tag_name).is_none() {
        return Err("updateInvalidRelease".into());
    }
    let asset = |name: &str, limit: u64| {
        let matches: Vec<_> = release
            .assets
            .iter()
            .filter(|asset| asset.name == name)
            .collect();
        let expected = format!("{root}/{}/{name}", release.tag_name);
        if matches.len() != 1 {
            return Err("updateAssetMissing".to_string());
        }
        let asset = matches[0];
        if asset.size == 0
            || asset.size > limit
            || asset.state != "uploaded"
            || asset.browser_download_url != expected
        {
            return Err("updateInvalidRelease".into());
        }
        Ok(asset.clone())
    };
    let binary = asset(name, MAX_BINARY)?;
    let checksum = asset(&format!("{name}.sha256"), 4096)?;
    Ok(Release {
        version: release.tag_name,
        binary,
        checksum,
    })
}

fn checksum(bytes: &[u8], name: &str) -> UpdateResult<String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "updateChecksumFailed")?;
    let fields: Vec<_> = text.split_whitespace().collect();
    if fields.len() != 2
        || fields[1] != name
        || fields[0].len() != 64
        || !fields[0]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("updateChecksumFailed".into());
    }
    Ok(fields[0].to_string())
}

fn install_permission(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(parent) = CString::new(parent.as_os_str().as_encoded_bytes()) else {
        return false;
    };
    meta.is_file()
        && meta.mode() & 0o6000 == 0
        && meta.uid() == unsafe { libc::geteuid() }
        && unsafe { libc::access(parent.as_ptr(), libc::W_OK | libc::X_OK) } == 0
}

impl Updater {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .user_agent("Shelt-Updater")
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let url = attempt.url();
                let host = url.host_str().unwrap_or_default();
                if attempt.previous().len() >= 5
                    || url.scheme() != "https"
                    || !(host == "github.com"
                        || host == "api.github.com"
                        || host.ends_with(".githubusercontent.com"))
                {
                    attempt.error("Unexpected update redirect")
                } else {
                    attempt.follow()
                }
            }))
            .build()?;
        Ok(Self(Arc::new(Inner {
            build: serde_json::from_slice(BUILD_VERSION)?,
            executable: fs::canonicalize(env::current_exe()?)?,
            client,
            latest_url: LATEST_URL.into(),
            release_root: RELEASE_ROOT.into(),
            cache: tokio::sync::Mutex::new(None),
            phase: Mutex::new(("idle", None)),
            installing: AtomicBool::new(false),
            restarting: AtomicBool::new(false),
            pending: Mutex::new(None),
            restart: tokio::sync::Notify::new(),
        })))
    }

    fn reason(&self) -> Option<&'static str> {
        if asset_name().is_none() {
            Some("updateUnsupported")
        } else if self.0.build.dirty || version_number(&self.0.build.version).is_none() {
            Some("updateDevelopment")
        } else if !install_permission(&self.0.executable) {
            Some("updateReadOnly")
        } else {
            None
        }
    }

    async fn latest(&self, force: bool) -> UpdateResult<Release> {
        let mut cached = self.0.cache.lock().await;
        if let Some(entry) = cached.as_ref() {
            let ttl = if entry.result.is_ok() {
                CHECK_INTERVAL
            } else {
                ERROR_INTERVAL
            };
            if !force && entry.at.elapsed() < ttl {
                return entry.result.clone();
            }
        }
        let result = async {
            let name = asset_name().ok_or("updateUnsupported")?;
            let response = self
                .0
                .client
                .get(&self.0.latest_url)
                .header("Accept", "application/vnd.github+json")
                .timeout(Duration::from_secs(20))
                .send()
                .await
                .map_err(|_| "updateCheckFailed")?;
            if response.status().as_u16() == 403 || response.status().as_u16() == 429 {
                return Err("updateRateLimited".into());
            }
            if !response.status().is_success() {
                return Err("updateCheckFailed".into());
            }
            release_from_json(
                &read_response(response, 1024 * 1024).await?,
                name,
                &self.0.release_root,
            )
        }
        .await;
        *cached = Some(Cached {
            at: Instant::now(),
            result: result.clone(),
        });
        result
    }

    pub async fn status(&self) -> UpdateStatus {
        let latest = self.latest(false).await;
        let (phase, error) = self.0.phase.lock().unwrap().clone();
        let latest_version = latest.as_ref().ok().map(|release| release.version.clone());
        let available = latest_version.as_deref().is_some_and(|version| {
            match version_number(&self.0.build.version) {
                Some(current) => version_number(version).is_some_and(|latest| latest > current),
                None => true,
            }
        });
        UpdateStatus {
            current_version: self.0.build.version.clone(),
            latest_version,
            available,
            can_install: self.reason().is_none(),
            reason: self.reason(),
            phase,
            error: error.or_else(|| latest.err()),
        }
    }

    fn set_phase(&self, phase: &'static str, error: Option<String>) {
        *self.0.phase.lock().unwrap() = (phase, error);
    }

    pub fn begin(&self) -> UpdateResult<()> {
        if let Some(reason) = self.reason() {
            return Err(reason.into());
        }
        if self.0.installing.swap(true, Ordering::AcqRel) {
            return Err("updateBusy".into());
        }
        self.set_phase("downloading", None);
        let updater = self.clone();
        tokio::spawn(async move {
            match updater.prepare().await {
                Ok(installation) => {
                    *updater.0.pending.lock().unwrap() = Some(installation);
                    updater.set_phase("restarting", None);
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    updater.0.restarting.store(true, Ordering::Release);
                    updater.0.restart.notify_one();
                }
                Err(error) => {
                    eprintln!("Shelt update failed: {error}");
                    updater.set_phase("error", Some(error));
                    updater.0.installing.store(false, Ordering::Release);
                }
            }
        });
        Ok(())
    }

    async fn prepare(&self) -> UpdateResult<Installation> {
        let mut installation = Installation::lock(&self.0.executable)?;
        let release = self.latest(true).await?;
        let latest = version_number(&release.version).ok_or("updateInvalidRelease")?;
        let current = version_number(&self.0.build.version).ok_or("updateDevelopment")?;
        if latest <= current {
            return Err("updateNoNewVersion".into());
        }
        let installed = probe_version(&installation.target).await?;
        if version_number(&installed.version).is_some_and(|version| version >= latest)
            && !installed.dirty
        {
            return Ok(installation);
        }
        for attempt in 1..=3 {
            match self.fetch_release(&release, &mut installation).await {
                Ok(()) => break,
                Err(error)
                    if attempt < 3
                        && matches!(
                            error.as_str(),
                            "updateDownloadFailed" | "updateChecksumFailed"
                        ) =>
                {
                    let _ = fs::remove_file(&installation.staged);
                    eprintln!("Shelt update attempt {attempt} failed: {error}, retrying");
                    tokio::time::sleep(Duration::from_secs(attempt)).await;
                }
                Err(error) => return Err(error),
            }
        }
        installation.replace()?;
        Ok(installation)
    }

    async fn fetch_release(
        &self,
        release: &Release,
        installation: &mut Installation,
    ) -> UpdateResult<()> {
        let checksum_response = self
            .0
            .client
            .get(&release.checksum.browser_download_url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "updateDownloadFailed")?;
        let expected = checksum(
            &read_response(checksum_response, 4096).await?,
            &release.binary.name,
        )?;
        let mut response = self
            .0
            .client
            .get(&release.binary.browser_download_url)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|_| "updateDownloadFailed")?;
        if !response.status().is_success() {
            return Err("updateDownloadFailed".into());
        }
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&installation.staged)
            .map_err(|_| "updateReadOnly")?;
        let mut output = tokio::fs::File::from_std(file);
        let mut digest = ring::digest::Context::new(&SHA256);
        let mut size = 0;
        while let Some(chunk) = response.chunk().await.map_err(|_| "updateDownloadFailed")? {
            size += chunk.len() as u64;
            if size > release.binary.size || size > MAX_BINARY {
                return Err("updateDownloadFailed".into());
            }
            digest.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|_| "updateWriteFailed")?;
        }
        output.sync_all().await.map_err(|_| "updateWriteFailed")?;
        drop(output);
        self.set_phase("verifying", None);
        let actual: String = digest
            .finish()
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if size != release.binary.size || actual != expected {
            return Err("updateChecksumFailed".into());
        }
        let candidate = probe_version(&installation.staged).await?;
        if candidate.version != release.version || candidate.dirty {
            return Err("updateInvalidBinary".into());
        }
        Ok(())
    }

    pub fn is_restarting(&self) -> bool {
        self.0.restarting.load(Ordering::Acquire)
    }
    pub fn stop_accepting(&self) {
        self.0.restarting.store(true, Ordering::Release);
    }
    pub async fn restart_requested(&self) {
        self.0.restart.notified().await;
    }
    pub fn take_installation(&self) -> Option<Installation> {
        self.0.pending.lock().unwrap().take()
    }
}

async fn read_response(mut response: reqwest::Response, max: usize) -> UpdateResult<Vec<u8>> {
    if !response.status().is_success() {
        return Err("updateDownloadFailed".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "updateDownloadFailed")? {
        if chunk.len() > max.saturating_sub(bytes.len()) {
            return Err("updateInvalidRelease".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn probe_version(path: &Path) -> UpdateResult<BuildInfo> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        TokioCommand::new(path)
            .arg("version")
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "updateInvalidBinary")?
    .map_err(|_| "updateInvalidBinary")?;
    if !output.status.success() || output.stdout.len() > 4096 {
        return Err("updateInvalidBinary".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "updateInvalidBinary".into())
}

#[derive(Debug)]
pub struct Installation {
    pub target: PathBuf,
    staged: PathBuf,
    backup: PathBuf,
    original: (u64, u64),
    replaced: bool,
    _lock: fs::File,
}

impl Installation {
    fn lock(target: &Path) -> UpdateResult<Self> {
        if !install_permission(target) {
            return Err("updateReadOnly".into());
        }
        let parent = target.parent().ok_or("updateReadOnly")?;
        let name = target
            .file_name()
            .ok_or("updateReadOnly")?
            .to_string_lossy();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(parent.join(format!(".{name}.update.lock")))
            .map_err(|_| "updateReadOnly")?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("updateBusy".into());
        }
        let meta = fs::metadata(target).map_err(|_| "updateReadOnly")?;
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self {
            target: target.to_path_buf(),
            staged: parent.join(format!(".{name}.download-{nonce}")),
            backup: parent.join(format!("{name}.backup-{nonce}")),
            original: (meta.dev(), meta.ino()),
            replaced: false,
            _lock: lock,
        })
    }

    fn replace(&mut self) -> UpdateResult<()> {
        let metadata = fs::metadata(&self.target).map_err(|_| "updateWriteFailed")?;
        if (metadata.dev(), metadata.ino()) != self.original {
            return Err("updateChangedOnDisk".into());
        }
        fs::set_permissions(
            &self.staged,
            fs::Permissions::from_mode(metadata.mode() & 0o777),
        )
        .map_err(|_| "updateWriteFailed")?;
        fs::hard_link(&self.target, &self.backup).map_err(|_| "updateWriteFailed")?;
        fs::rename(&self.staged, &self.target).map_err(|_| "updateWriteFailed")?;
        self.replaced = true;
        eprintln!(
            "Shelt update installed; previous binary: {}",
            self.backup.display()
        );
        Ok(())
    }

    pub fn exec(mut self) -> std::io::Error {
        let error = Command::new(&self.target).arg("foreground").exec();
        eprintln!("Shelt update restart failed: {error}");
        if self.replaced {
            if let Err(error) = fs::rename(&self.backup, &self.target) {
                return error;
            }
            self.replaced = false;
            return Command::new(&self.target).arg("foreground").exec();
        }
        error
    }
}

impl Drop for Installation {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.staged);
    }
}

pub async fn status_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !allowed_host(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Forbidden host").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    let mut response = secure(Json(state.updater.status().await).into_response());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn install_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !allowed_host(&state, &headers) || !allowed_origin(&state, &headers) {
        return secure((StatusCode::FORBIDDEN, "Cross-origin rejected").into_response());
    }
    if !authenticated(&state, &headers) {
        return secure((StatusCode::UNAUTHORIZED, "Authentication required").into_response());
    }
    match state.updater.begin() {
        Ok(()) => {
            secure((StatusCode::ACCEPTED, Json(serde_json::json!({"ok":true}))).into_response())
        }
        Err(error) => secure(
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error":error})),
            )
                .into_response(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = format!(
                "shelt-updater-test-{}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_updater(build: BuildInfo, executable: PathBuf) -> Updater {
        Updater(Arc::new(Inner {
            build,
            executable,
            client: reqwest::Client::new(),
            latest_url: LATEST_URL.into(),
            release_root: RELEASE_ROOT.into(),
            cache: tokio::sync::Mutex::new(None),
            phase: Mutex::new(("idle", None)),
            installing: AtomicBool::new(false),
            restarting: AtomicBool::new(false),
            pending: Mutex::new(None),
            restart: tokio::sync::Notify::new(),
        }))
    }

    fn test_build(version: &str, dirty: bool) -> BuildInfo {
        BuildInfo {
            version: version.into(),
            commit: "0123456789abcdef".into(),
            dirty,
        }
    }

    fn release_json(
        tag: &str,
        draft: bool,
        prerelease: bool,
        root: &str,
        name: &str,
        binary_size: u64,
    ) -> String {
        let checksum = format!("{name}.sha256");
        let url = |file: &str| format!("{root}/{tag}/{file}");
        format!(
            r#"{{"tag_name":"{tag}","draft":{draft},"prerelease":{prerelease},"assets":[{{"name":"{name}","size":{binary_size},"state":"uploaded","browser_download_url":"{}"}},{{"name":"{checksum}","size":80,"state":"uploaded","browser_download_url":"{}"}}]}}"#,
            url(name),
            url(&checksum)
        )
    }

    #[test]
    fn version_number_parses_release_tags() {
        assert_eq!(version_number("v0.0.21"), Some([0, 0, 21]));
        assert_eq!(version_number("v1.23.456"), Some([1, 23, 456]));
        assert_eq!(version_number("v10.20.30"), Some([10, 20, 30]));
        assert_eq!(version_number("1.2.3"), None);
        assert_eq!(version_number("v1.2"), None);
        assert_eq!(version_number("v1.2.3.4"), None);
        assert_eq!(version_number(""), None);
        assert_eq!(version_number("vv1.2.3"), None);
        assert_eq!(version_number("v1.2.x"), None);
        assert_eq!(version_number("v1.2.-3"), None);
        assert_eq!(version_number("v01.2.3"), None);
        assert_eq!(version_number("v1.02.3"), None);
        assert_eq!(version_number("v99999999999999999999.0.0"), None);
    }

    #[test]
    fn asset_name_matches_release_assets() {
        match (env::consts::OS, env::consts::ARCH) {
            ("linux", "x86_64") => assert_eq!(asset_name(), Some("shelt-linux-x86_64-musl")),
            ("macos", "aarch64") => assert_eq!(asset_name(), Some("shelt-macos-aarch64")),
            _ => assert_eq!(asset_name(), None),
        }
    }

    #[test]
    fn release_from_json_accepts_valid_latest_release() {
        let root = "https://github.com/cnyarx/shelt/releases/download";
        let bytes = release_json(
            "v0.0.22",
            false,
            false,
            root,
            "shelt-linux-x86_64-musl",
            8 * 1024 * 1024,
        );
        let release = release_from_json(bytes.as_bytes(), "shelt-linux-x86_64-musl", root).unwrap();
        assert_eq!(release.version, "v0.0.22");
        assert_eq!(release.binary.name, "shelt-linux-x86_64-musl");
        assert_eq!(release.checksum.name, "shelt-linux-x86_64-musl.sha256");
        assert_eq!(
            release.binary.browser_download_url,
            format!("{root}/v0.0.22/shelt-linux-x86_64-musl")
        );
    }

    #[test]
    fn release_from_json_rejects_invalid_releases() {
        let root = "https://github.com/cnyarx/shelt/releases/download";
        let name = "shelt-linux-x86_64-musl";
        let check = |bytes: String| release_from_json(bytes.as_bytes(), name, root);

        assert_eq!(
            check(release_json("v0.0.22", true, false, root, name, 1024)).unwrap_err(),
            "updateInvalidRelease"
        );
        assert_eq!(
            check(release_json("v0.0.22", false, true, root, name, 1024)).unwrap_err(),
            "updateInvalidRelease"
        );
        assert_eq!(
            check(release_json("latest", false, false, root, name, 1024)).unwrap_err(),
            "updateInvalidRelease"
        );
        assert_eq!(
            check(release_json(
                "v0.0.22",
                false,
                false,
                "https://evil.example.com/download",
                name,
                1024
            ))
            .unwrap_err(),
            "updateInvalidRelease"
        );
        assert_eq!(
            check(release_json("v0.0.22", false, false, root, name, 0)).unwrap_err(),
            "updateInvalidRelease"
        );
        assert_eq!(
            check(release_json(
                "v0.0.22",
                false,
                false,
                root,
                name,
                MAX_BINARY + 1
            ))
            .unwrap_err(),
            "updateInvalidRelease"
        );
        assert_eq!(
            check(
                r#"{"tag_name":"v0.0.22","draft":false,"prerelease":false,"assets":[]}"#
                    .to_string()
            )
            .unwrap_err(),
            "updateAssetMissing"
        );
        assert_eq!(
            check(r#"not json"#.to_string()).unwrap_err(),
            "updateInvalidRelease"
        );

        let url = |file: &str| format!("{root}/v0.0.22/{file}");
        let duplicate = format!(
            r#"{{"tag_name":"v0.0.22","draft":false,"prerelease":false,"assets":[{{"name":"{name}","size":10,"state":"uploaded","browser_download_url":"{}"}},{{"name":"{name}","size":10,"state":"uploaded","browser_download_url":"{}"}}]}}"#,
            url(name),
            url(name)
        );
        assert_eq!(check(duplicate).unwrap_err(), "updateAssetMissing");

        let not_uploaded = format!(
            r#"{{"tag_name":"v0.0.22","draft":false,"prerelease":false,"assets":[{{"name":"{name}","size":10,"state":"starter","browser_download_url":"{}"}}]}}"#,
            url(name)
        );
        assert_eq!(check(not_uploaded).unwrap_err(), "updateInvalidRelease");
    }

    #[test]
    fn checksum_parses_release_checksum_files() {
        let digest = "a".repeat(64);
        let name = "shelt-linux-x86_64-musl";
        assert_eq!(
            checksum(format!("{digest}  {name}\n").as_bytes(), name),
            Ok(digest.clone())
        );
        assert_eq!(
            checksum(format!("{digest}\t\t{name}").as_bytes(), name),
            Ok(digest.clone())
        );
        assert_eq!(
            checksum(format!("{digest}  other-binary").as_bytes(), name).unwrap_err(),
            "updateChecksumFailed"
        );
        assert_eq!(
            checksum(format!("{}  {name}", "a".repeat(63)).as_bytes(), name).unwrap_err(),
            "updateChecksumFailed"
        );
        assert_eq!(
            checksum(format!("{}  {name}", "A".repeat(64)).as_bytes(), name).unwrap_err(),
            "updateChecksumFailed"
        );
        assert_eq!(
            checksum(format!("{digest} {name} extra").as_bytes(), name).unwrap_err(),
            "updateChecksumFailed"
        );
        assert_eq!(
            checksum(b"\xff\xfe binary", name).unwrap_err(),
            "updateChecksumFailed"
        );
    }

    #[test]
    fn install_permission_checks_file_and_directory() {
        let dir = TempDir::new();
        let target = dir.path().join("shelt");
        fs::write(&target, b"binary").unwrap();
        assert!(install_permission(&target));

        assert!(!install_permission(&dir.path().join("missing")));

        let setuid = dir.path().join("setuid");
        fs::write(&setuid, b"binary").unwrap();
        fs::set_permissions(&setuid, fs::Permissions::from_mode(0o4755)).unwrap();
        assert!(!install_permission(&setuid));

        if unsafe { libc::geteuid() } != 0 {
            let readonly = dir.path().join("readonly");
            fs::create_dir(&readonly).unwrap();
            let nested = readonly.join("shelt");
            fs::write(&nested, b"binary").unwrap();
            fs::set_permissions(&readonly, fs::Permissions::from_mode(0o500)).unwrap();
            assert!(!install_permission(&nested));
            fs::set_permissions(&readonly, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    #[test]
    fn updater_reason_classifies_install_support() {
        let dir = TempDir::new();
        let target = dir.path().join("shelt");
        fs::write(&target, b"binary").unwrap();

        let clean = test_updater(test_build("v0.0.21", false), target.clone());
        assert_eq!(clean.reason(), None);

        let dirty = test_updater(test_build("v0.0.21", true), target.clone());
        assert_eq!(dirty.reason(), Some("updateDevelopment"));

        let unversioned = test_updater(test_build("dev-build", false), target);
        assert_eq!(unversioned.reason(), Some("updateDevelopment"));

        if unsafe { libc::geteuid() } != 0 {
            let readonly = dir.path().join("readonly");
            fs::create_dir(&readonly).unwrap();
            let nested = readonly.join("shelt");
            fs::write(&nested, b"binary").unwrap();
            fs::set_permissions(&readonly, fs::Permissions::from_mode(0o500)).unwrap();
            let unwritable = test_updater(test_build("v0.0.21", false), nested);
            assert_eq!(unwritable.reason(), Some("updateReadOnly"));
            fs::set_permissions(&readonly, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    #[test]
    fn updater_restart_flags_and_pending_installation() {
        let dir = TempDir::new();
        let target = dir.path().join("shelt");
        fs::write(&target, b"binary").unwrap();
        let updater = test_updater(test_build("v0.0.21", false), target);
        assert!(!updater.is_restarting());
        assert!(updater.take_installation().is_none());
        updater.stop_accepting();
        assert!(updater.is_restarting());
    }

    #[test]
    fn installation_lock_is_exclusive_per_target() {
        let dir = TempDir::new();
        let target = dir.path().join("shelt");
        fs::write(&target, b"old").unwrap();

        let installation = Installation::lock(&target).unwrap();
        assert!(dir.path().join(".shelt.update.lock").exists());
        assert_eq!(Installation::lock(&target).unwrap_err(), "updateBusy");

        drop(installation);
        assert!(Installation::lock(&target).is_ok());
    }

    #[test]
    fn installation_replace_swaps_files_and_keeps_backup() {
        let dir = TempDir::new();
        let target = dir.path().join("shelt");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();

        let mut installation = Installation::lock(&target).unwrap();
        fs::write(&installation.staged, b"new").unwrap();
        fs::set_permissions(&installation.staged, fs::Permissions::from_mode(0o700)).unwrap();
        installation.replace().unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o755);
        assert_eq!(fs::read(&installation.backup).unwrap(), b"old");
        assert!(!installation.staged.exists());
    }

    #[test]
    fn installation_replace_detects_target_replaced_by_others() {
        let dir = TempDir::new();
        let target = dir.path().join("shelt");
        fs::write(&target, b"old").unwrap();

        let mut installation = Installation::lock(&target).unwrap();
        let other = dir.path().join("other");
        fs::write(&other, b"other").unwrap();
        fs::rename(&other, &target).unwrap();
        fs::write(&installation.staged, b"new").unwrap();

        assert_eq!(installation.replace().unwrap_err(), "updateChangedOnDisk");
        assert_eq!(fs::read(&target).unwrap(), b"other");
    }

    #[test]
    fn installation_drop_removes_staged_file() {
        let dir = TempDir::new();
        let target = dir.path().join("shelt");
        fs::write(&target, b"old").unwrap();

        let installation = Installation::lock(&target).unwrap();
        fs::write(&installation.staged, b"partial").unwrap();
        let staged = installation.staged.clone();
        drop(installation);

        assert!(!staged.exists());
        assert!(target.exists());
    }

    #[test]
    fn installation_exec_reports_error_without_rollback_when_not_replaced() {
        let dir = TempDir::new();
        let target = dir.path().join("shelt");
        fs::write(&target, b"not an executable").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();

        let installation = Installation::lock(&target).unwrap();
        let error = installation.exec();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&target).unwrap(), b"not an executable");
    }
}
