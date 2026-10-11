use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{fs::{File, OpenOptions}, path::{Path, PathBuf}, sync::{Mutex, MutexGuard}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::Manager;

const MAX_WORKSPACE_BYTES: usize = 50 * 1024 * 1024;
const MAX_BACKUPS: usize = 10;
const BACKUP_INTERVAL_MS: i64 = 60_000;
const PROTECTED_TAG: &str = "__reqmasProtected";
#[cfg(windows)]
const PROTECTED_VERSION: &str = "windows-dpapi-v1";
#[cfg(not(windows))]
const PROTECTED_VERSION: &str = "system-keyring-aes256gcm-v1";

const WORKSPACE_IN_USE: &str = "Another Reqmas instance is already using this workspace. Close the other instance, then restart this copy of Reqmas.";

pub struct WorkspaceLock {
    mutex: Mutex<()>,
    // Keep the OS lease for the app lifetime, including between SQLite commands.
    lease: Result<File, String>,
}

impl WorkspaceLock {
    pub fn initialize(app: &tauri::AppHandle) -> Self { Self::for_path(store_path(app)) }
    fn for_path(path: Result<PathBuf, String>) -> Self {
        Self { mutex: Mutex::new(()), lease: path.and_then(|path| acquire_workspace_lease(&path)) }
    }
    fn guard(&self) -> Result<MutexGuard<'_, ()>, String> {
        // A failed startup lease reaches the existing workspace bootstrap error UI.
        self.lease.as_ref().map_err(Clone::clone)?;
        self.mutex.lock().map_err(|_| "Workspace storage is busy".into())
    }
}

fn acquire_workspace_lease(path: &Path) -> Result<File, String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|_| "Unable to create the workspace data directory")?; }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    // A separate permanent file leaves normal SQLite/WAL access available. Its
    // existence is not the lock; Windows releases the handle even after a crash.
    let file = options.open(path.with_extension("sqlite3.lock")).map_err(|error| {
        if cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) { WORKSPACE_IN_USE.to_string() }
        else { format!("Unable to acquire the workspace lock: {error}") }
    })?;
    #[cfg(not(windows))]
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => WORKSPACE_IN_USE.to_string(),
        std::fs::TryLockError::Error(error) => format!("Unable to acquire the workspace lock: {error}"),
    })?;
    Ok(file)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackup { id: i64, created_at: i64, size: i64 }

struct Store { connection: Connection }

fn db_error(error: rusqlite::Error) -> String { format!("Workspace database: {error}") }
fn timestamp() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64 }

fn parse_workspace(source: &str) -> Result<Value, String> {
    if source.len() > MAX_WORKSPACE_BYTES { return Err("Workspace exceeds the 50 MiB limit".into()); }
    let value: Value = serde_json::from_str(source).map_err(|_| "Workspace is not valid JSON".to_string())?;
    let object = value.as_object().ok_or("Workspace must be an object")?;
    for field in ["collections", "requests", "environments", "cookies", "history"] {
        if !object.get(field).is_some_and(Value::is_array) { return Err(format!("Workspace {field} must be an array")); }
    }
    if !object.get("environmentId").is_some_and(Value::is_string) { return Err("Workspace environmentId must be a string".into()); }
    if !object.get("trash").is_some_and(|trash| trash.get("requests").is_some_and(Value::is_array) && trash.get("collections").is_some_and(Value::is_array)) { return Err("Workspace trash must contain requests and collections arrays".into()); }
    Ok(value)
}

#[cfg(windows)]
fn protect_bytes(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN}};
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len().try_into().map_err(|_| "Secret is too large")?, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if decrypt { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        else { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    };
    if ok == 0 { return Err(if decrypt { "Unable to decrypt a workspace secret. Use the Windows account that saved it, or restore an exported backup." } else { "Windows could not protect a workspace secret. The workspace was not saved." }.into()); }
    let result = if output.cbData == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() } };
    if !output.pbData.is_null() { unsafe { std::ptr::write_bytes(output.pbData, 0, output.cbData as usize); LocalFree(output.pbData as _); } }
    Ok(result)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::secure_storage::protect_bytes;
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn protect_bytes(_bytes: &[u8], _decrypt: bool) -> Result<Vec<u8>, String> { Err("This operating system has no supported secure workspace storage".into()) }

fn protect_value(value: &mut Value, decrypt: bool) -> Result<(), String> {
    if decrypt {
        let object = value.as_object().ok_or("Workspace secret is not encrypted")?;
        if object.get(PROTECTED_TAG).and_then(Value::as_str) != Some(PROTECTED_VERSION) { return Err("Unsupported workspace secret encryption".into()); }
        let ciphertext = object.get("ciphertext").and_then(Value::as_str).ok_or("Workspace secret ciphertext is missing")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(ciphertext).map_err(|_| "Workspace secret ciphertext is invalid")?;
        let plaintext = protect_bytes(&bytes, true)?;
        *value = Value::String(String::from_utf8(plaintext).map_err(|_| "Decrypted workspace secret is invalid")?);
    } else {
        let plaintext = value.as_str().ok_or("A marked workspace secret must have a string value")?;
        let bytes = protect_bytes(plaintext.as_bytes(), false)?;
        *value = json!({"__reqmasProtected": PROTECTED_VERSION, "ciphertext": base64::engine::general_purpose::STANDARD.encode(bytes)});
    }
    Ok(())
}

fn transform_secrets(value: &mut Value, decrypt: bool) -> Result<(), String> {
    match value {
        Value::Array(values) => for item in values { transform_secrets(item, decrypt)?; },
        Value::Object(object) => {
            let marked = object.get("secret").and_then(Value::as_bool) == Some(true);
            if marked { protect_value(object.get_mut("value").ok_or("A marked workspace secret has no value")?, decrypt)?; }
            for (key, item) in object.iter_mut() {
                if marked && key == "value" { continue; }
                let secret_fields: &[&str] = match key.as_str() {
                    "connection" => &["proxyPassword", "clientKeyPem"],
                    "basicAuth" => &["password"],
                    "oauth" => &["clientSecret", "accessToken", "refreshToken"],
                    "apiKey" => &["value"],
                    _ => &[],
                };
                if let Some(options) = item.as_object_mut() { for field in secret_fields { if let Some(secret) = options.get_mut(*field) { protect_value(secret, decrypt)?; } } }
                if key == "bearerToken" { protect_value(item, decrypt)?; }
                if key == "cookies" {
                    if let Some(cookies) = item.as_array_mut() { for cookie in cookies { if let Some(value) = cookie.get_mut("value") { protect_value(value, decrypt)?; } } }
                }
                transform_secrets(item, decrypt)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn encoded_workspace(mut value: Value) -> Result<String, String> {
    transform_secrets(&mut value, false)?;
    let result = serde_json::to_string(&value).map_err(|_| "Unable to encode workspace")?;
    if result.len() > MAX_WORKSPACE_BYTES { return Err("Encrypted workspace exceeds the 50 MiB limit".into()); }
    Ok(result)
}

fn decoded_workspace(source: &str) -> Result<Value, String> {
    let mut value = parse_workspace(source)?;
    transform_secrets(&mut value, true)?;
    Ok(value)
}

impl Store {
    fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|_| "Unable to create the workspace data directory")?; }
        let connection = Connection::open(path).map_err(db_error)?;
        connection.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(db_error)?;
        if version > 1 { return Err("This workspace database was created by a newer Reqmas version".into()); }
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
            PRAGMA user_version=1;").map_err(db_error)?;
        Ok(Self { connection })
    }
    fn raw(&self) -> Result<Option<String>, String> { self.connection.query_row("SELECT payload FROM workspace WHERE id=1", [], |row| row.get(0)).optional().map_err(db_error) }
    fn load(&self) -> Result<Option<String>, String> {
        self.raw()?.map(|source| decoded_workspace(&source).and_then(|value| serde_json::to_string(&value).map_err(|_| "Unable to decode workspace".into()))).transpose()
    }
    fn save(&mut self, source: &str, now: i64) -> Result<(), String> { self.save_options(source, now, false) }
    fn save_options(&mut self, source: &str, now: i64, force_backup: bool) -> Result<(), String> {
        let value = parse_workspace(source)?;
        let previous = self.raw()?;
        if let Some(ref previous) = previous {
            if !force_backup && decoded_workspace(previous)? == value { return Ok(()); }
        }
        let encrypted = encoded_workspace(value)?;
        let transaction = self.connection.transaction().map_err(db_error)?;
        let last_backup: Option<i64> = transaction.query_row("SELECT MAX(created_at) FROM backups", [], |row| row.get(0)).map_err(db_error)?;
        if force_backup || previous.is_none() || last_backup.is_none_or(|time| now.saturating_sub(time) >= BACKUP_INTERVAL_MS) {
            transaction.execute("INSERT INTO backups(payload, created_at) VALUES(?1, ?2)", params![previous.as_deref().unwrap_or(&encrypted), now]).map_err(db_error)?;
        }
        transaction.execute("INSERT INTO workspace(id, payload, updated_at) VALUES(1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at", params![encrypted, now]).map_err(db_error)?;
        transaction.execute("DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT ?1)", [MAX_BACKUPS as i64]).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }
    fn backups(&self) -> Result<Vec<WorkspaceBackup>, String> {
        let mut query = self.connection.prepare("SELECT id, created_at, length(CAST(payload AS BLOB)) FROM backups ORDER BY id DESC").map_err(db_error)?;
        let rows = query.query_map([], |row| Ok(WorkspaceBackup { id: row.get(0)?, created_at: row.get(1)?, size: row.get(2)? })).map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }
    fn restore(&mut self, backup_id: i64, now: i64) -> Result<String, String> {
        let backup: String = self.connection.query_row("SELECT payload FROM backups WHERE id=?1", [backup_id], |row| row.get(0)).optional().map_err(db_error)?.ok_or("Automatic workspace backup was not found")?;
        let plaintext = serde_json::to_string(&decoded_workspace(&backup)?).map_err(|_| "Unable to decode workspace backup")?;
        let previous = self.raw()?;
        let transaction = self.connection.transaction().map_err(db_error)?;
        if let Some(previous) = previous { transaction.execute("INSERT INTO backups(payload, created_at) VALUES(?1, ?2)", params![previous, now]).map_err(db_error)?; }
        transaction.execute("INSERT INTO workspace(id,payload,updated_at) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at", params![backup, now]).map_err(db_error)?;
        transaction.execute("DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT ?1)", [MAX_BACKUPS as i64]).map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(plaintext)
    }
    fn read_backup(&self, backup_id: i64) -> Result<String, String> {
        let backup: String = self.connection.query_row("SELECT payload FROM backups WHERE id=?1", [backup_id], |row| row.get(0)).optional().map_err(db_error)?.ok_or("Automatic workspace backup was not found")?;
        serde_json::to_string(&decoded_workspace(&backup)?).map_err(|_| "Unable to decode workspace backup".into())
    }
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> { app.path().app_data_dir().map(|path| path.join("workspace.sqlite3")).map_err(|_| "Unable to locate the workspace data directory".into()) }

#[tauri::command(async)]
pub fn load_workspace(app: tauri::AppHandle, lock: tauri::State<'_, WorkspaceLock>) -> Result<Option<String>, String> {
    let _guard = lock.guard()?;
    Store::open(&store_path(&app)?)?.load()
}
#[tauri::command(async)]
pub fn save_workspace(app: tauri::AppHandle, lock: tauri::State<'_, WorkspaceLock>, workspace: String, force_backup: Option<bool>) -> Result<(), String> {
    let _guard = lock.guard()?;
    let mut store = Store::open(&store_path(&app)?)?;
    if force_backup == Some(true) { store.save_options(&workspace, timestamp(), true) } else { store.save(&workspace, timestamp()) }
}
#[tauri::command(async)]
pub fn list_workspace_backups(app: tauri::AppHandle, lock: tauri::State<'_, WorkspaceLock>) -> Result<Vec<WorkspaceBackup>, String> {
    let _guard = lock.guard()?;
    Store::open(&store_path(&app)?)?.backups()
}
#[tauri::command(async)]
pub fn restore_workspace_backup(app: tauri::AppHandle, lock: tauri::State<'_, WorkspaceLock>, backup_id: i64) -> Result<String, String> {
    let _guard = lock.guard()?;
    Store::open(&store_path(&app)?)?.restore(backup_id, timestamp())
}
#[tauri::command(async)]
pub fn read_workspace_backup(app: tauri::AppHandle, lock: tauri::State<'_, WorkspaceLock>, backup_id: i64) -> Result<String, String> {
    let _guard = lock.guard()?;
    Store::open(&store_path(&app)?)?.read_backup(backup_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);
    struct TestStore { store: Store, directory: PathBuf }
    impl TestStore {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!("reqmas-storage-test-{}-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(), NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)));
            let store = Store::open(&directory.join("workspace.sqlite3")).unwrap();
            Self { store, directory }
        }
    }
    impl Drop for TestStore { fn drop(&mut self) {
        let connection = std::mem::replace(&mut self.store.connection, Connection::open_in_memory().unwrap()); let _ = connection.close();
        if let (Ok(target), Ok(temp_root)) = (self.directory.canonicalize(), std::env::temp_dir().canonicalize()) {
            if target.starts_with(&temp_root) && target.file_name().is_some_and(|name| name.to_string_lossy().starts_with("reqmas-storage-test-")) { let _ = std::fs::remove_dir_all(target); }
        }
    } }
    fn workspace(name: &str) -> String { json!({ "collections": [], "requests": [], "environments": [], "environmentId": "", "cookies": [], "history": [], "trash": {"requests": [], "collections": []}, "theme": "dark", "name": name }).to_string() }
    #[test]
    fn workspace_lease_rejects_a_second_owner_without_locking_sqlite_connections() {
        let mut test = TestStore::new();
        let path = test.directory.join("workspace.sqlite3");
        let first = WorkspaceLock::for_path(Ok(path.clone()));
        drop(first.guard().unwrap());
        test.store.save(&workspace("initial"), 1000).unwrap();
        let second = WorkspaceLock::for_path(Ok(path.clone()));
        assert_eq!(second.guard().unwrap_err(), WORKSPACE_IN_USE);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.load().unwrap().unwrap(), workspace("initial"));
        { let _guard = first.guard().unwrap(); test.store.save(&workspace("first instance edit"), 1001).unwrap(); }
        assert_eq!(reopened.load().unwrap().unwrap(), workspace("first instance edit"));
        drop(reopened);
        drop(first);
        // A leftover sidecar does not represent a stale lock after handle release.
        assert!(path.with_extension("sqlite3.lock").exists());
        let restarted = WorkspaceLock::for_path(Ok(path));
        drop(restarted.guard().unwrap());
        assert_eq!(test.store.load().unwrap().unwrap(), workspace("first instance edit"));
    }
    #[test]
    fn workspace_lease_is_exclusive_across_processes_and_released_on_exit() {
        let test = TestStore::new();
        let path = test.directory.join("workspace.sqlite3");
        let first = WorkspaceLock::for_path(Ok(path.clone()));
        drop(first.guard().unwrap());
        let probe = |expectation: &str| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "workspace_store::tests::workspace_lease_subprocess_probe", "--nocapture"])
                .env("REQMAS_WORKSPACE_LEASE_TEST_PATH", &path)
                .env("REQMAS_WORKSPACE_LEASE_TEST_EXPECTATION", expectation)
                .output().unwrap();
            assert!(output.status.success(), "Lease subprocess failed: {}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        };
        probe("blocked");
        drop(first);
        probe("available");
        // The successful subprocess exited while owning its lease.
        drop(WorkspaceLock::for_path(Ok(path)).guard().unwrap());
    }
    #[test]
    fn workspace_lease_subprocess_probe() {
        let Some(path) = std::env::var_os("REQMAS_WORKSPACE_LEASE_TEST_PATH") else { return; };
        let lease = WorkspaceLock::for_path(Ok(PathBuf::from(path)));
        match std::env::var("REQMAS_WORKSPACE_LEASE_TEST_EXPECTATION").unwrap().as_str() {
            "blocked" => assert_eq!(lease.guard().unwrap_err(), WORKSPACE_IN_USE),
            "available" => { drop(lease.guard().unwrap()); },
            other => panic!("Unexpected lease test expectation: {other}"),
        }
    }
    #[test]
    fn first_migration_preserves_workspace_metadata_and_survives_reopening() {
        let mut test = TestStore::new(); assert_eq!(test.store.load().unwrap(), None);
        let original = workspace("legacy localStorage"); test.store.save(&original, 1000).unwrap();
        assert_eq!(test.store.load().unwrap().unwrap(), original);
        assert_eq!(test.store.backups().unwrap().len(), 1);
        let reopened = Store::open(&test.directory.join("workspace.sqlite3")).unwrap();
        assert_eq!(reopened.load().unwrap().unwrap(), original);
    }
    #[test]
    fn invalid_or_oversized_save_never_overwrites_existing_workspace() {
        let mut test = TestStore::new(); let original = workspace("existing"); test.store.save(&original, 1000).unwrap();
        for source in ["{secret text", "null", "{}", "[]"] { assert!(test.store.save(source, 100000).is_err()); }
        assert!(test.store.save(&"a".repeat(MAX_WORKSPACE_BYTES + 1), 100000).unwrap_err().contains("50 MiB"));
        assert_eq!(test.store.load().unwrap().unwrap(), original); assert_eq!(test.store.backups().unwrap().len(), 1);
    }
    #[test]
    fn backups_are_rate_limited_bounded_and_restore_is_atomic() {
        let mut test = TestStore::new(); test.store.save(&workspace("first"), 1000).unwrap();
        for i in 0..30 { test.store.save(&workspace(&format!("edit {i}")), 1001 + i).unwrap(); }
        assert_eq!(test.store.backups().unwrap().len(), 1);
        for i in 1..20 { test.store.save(&workspace(&format!("minute {i}")), 1000 + i * BACKUP_INTERVAL_MS).unwrap(); }
        let backups = test.store.backups().unwrap(); assert_eq!(backups.len(), MAX_BACKUPS);
        let before = test.store.load().unwrap().unwrap();
        let preview = test.store.read_backup(backups[0].id).unwrap(); assert_ne!(preview, before); assert_eq!(test.store.load().unwrap().unwrap(), before);
        assert!(test.store.restore(i64::MAX, 2_000_000).is_err()); assert_eq!(test.store.load().unwrap().unwrap(), before);
        let restored = test.store.restore(backups[0].id, 2_000_000).unwrap();
        assert_ne!(restored, before); assert_eq!(test.store.load().unwrap().unwrap(), restored);
        let safety = test.store.backups().unwrap()[0].id;
        assert_eq!(test.store.restore(safety, 2_000_001).unwrap(), before);
    }
    #[test]
    fn manual_restore_save_snapshots_current_workspace_inside_rate_limit() {
        let mut test = TestStore::new(); test.store.save(&workspace("first"), 1000).unwrap(); test.store.save(&workspace("edited"), 1001).unwrap();
        assert_eq!(test.store.backups().unwrap().len(), 1);
        test.store.save_options(&workspace("imported"), 1002, true).unwrap();
        let backups = test.store.backups().unwrap(); assert_eq!(backups.len(), 2);
        assert_eq!(test.store.read_backup(backups[0].id).unwrap(), workspace("edited"));
        assert_eq!(test.store.load().unwrap().unwrap(), workspace("imported"));
    }
    #[test]
    fn sqlite_failure_rolls_back_workspace_and_backup_changes() {
        let mut test = TestStore::new(); let original = workspace("existing"); test.store.save(&original, 1000).unwrap();
        test.store.connection.execute_batch("CREATE TRIGGER fail_save BEFORE UPDATE ON workspace BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;").unwrap();
        assert!(test.store.save(&workspace("next"), 100000).is_err());
        assert_eq!(test.store.load().unwrap().unwrap(), original); assert_eq!(test.store.backups().unwrap().len(), 1);
    }
    #[test]
    fn marked_variables_and_connection_credentials_are_encrypted_in_workspace_and_backups() {
        let mut test = TestStore::new(); let mut value: Value = serde_json::from_str(&workspace("secure")).unwrap();
        value["environments"] = json!([{"variables": [{"key": "token", "value": "secret-demo-😀", "secret": true}, {"key": "normal", "value": "public-demo"}]}]);
        value["requests"] = json!([{"connection": {"proxyPassword": "proxy-demo", "clientKeyPem": "key-demo", "caPem": "public-ca"}, "basicAuth": {"username": "user", "password": "basic-demo"}, "bearerToken": "bearer-demo", "oauth": {"clientSecret": "oauth-secret-demo", "accessToken": "access-demo", "refreshToken": "refresh-demo"}, "apiKey": {"key": "X-Key", "value": "apikey-demo"}}]);
        value["cookies"] = json!([{"name": "sid", "value": "cookie-demo"}]);
        let original = value.to_string(); test.store.save(&original, 1000).unwrap();
        let stored = test.store.raw().unwrap().unwrap();
        for secret in ["secret-demo", "proxy-demo", "key-demo", "basic-demo", "bearer-demo", "oauth-secret-demo", "access-demo", "refresh-demo", "apikey-demo", "cookie-demo"] { assert!(!stored.contains(secret)); }
        assert!(stored.contains("public-demo")); assert!(stored.contains(PROTECTED_VERSION));
        assert_eq!(test.store.load().unwrap().unwrap(), original);
        let id = test.store.backups().unwrap()[0].id;
        let backup: String = test.store.connection.query_row("SELECT payload FROM backups WHERE id=?1", [id], |row| row.get(0)).unwrap();
        assert!(!backup.contains("secret-demo"));
        test.store.save(&workspace("changed"), 200000).unwrap();
        assert_eq!(test.store.restore(id, 200001).unwrap(), original);
    }
    #[cfg(windows)]
    #[test]
    fn empty_secret_values_round_trip_with_dpapi() { assert_eq!(protect_bytes(&protect_bytes(&[], false).unwrap(), true).unwrap(), Vec::<u8>::new()); }
    #[test]
    fn invalid_encrypted_secret_fails_without_replacing_database() {
        let mut test = TestStore::new(); let original = workspace("existing"); test.store.save(&original, 1000).unwrap();
        let mut malformed: Value = serde_json::from_str(&original).unwrap(); malformed["requests"] = json!([{"variables": [{"secret": true, "value": {"ciphertext": "not valid"}}]}]);
        assert!(test.store.save(&malformed.to_string(), 100000).is_err()); assert_eq!(test.store.load().unwrap().unwrap(), original);
        let mut value = json!({"secret": true, "value": {"__reqmasProtected": PROTECTED_VERSION, "ciphertext": "AA=="}});
        assert!(transform_secrets(&mut value, true).is_err());
    }
}
