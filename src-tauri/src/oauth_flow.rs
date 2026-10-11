use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::oneshot};
use url::Url;

#[derive(Default)]
pub struct OAuthSessions(Mutex<Sessions>);
#[derive(Default)]
struct Sessions { running: HashMap<String, oneshot::Sender<()>>, cancelled: HashMap<String, Instant> }

fn redirect_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid OAuth Redirect URI")?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none_or(|port| port == 0) || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.query().is_some() {
        return Err("Redirect URI must be http://127.0.0.1:PORT/path without credentials, query or fragment".into());
    }
    Ok(url)
}
fn checked_authorization(value: &str, redirect: &Url, expected_state: &str) -> Result<Url, String> {
    if value.len() > 32768 { return Err("OAuth Authorization URL is too long".into()); }
    let url = Url::parse(value).map_err(|_| "Invalid OAuth Authorization URL")?;
    if !["https", "http"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.scheme() == "http" && ![Some("127.0.0.1"), Some("localhost"), Some("[::1]")].contains(&url.host_str()) { return Err("Authorization URL requires HTTPS (HTTP is allowed only on loopback)".into()); }
    let pairs: Vec<_> = url.query_pairs().collect();
    for key in ["state", "redirect_uri", "response_type", "code_challenge_method", "code_challenge", "client_id"] {
        if pairs.iter().filter(|(name, _)| name == key).count() != 1 { return Err("OAuth parameters must be present exactly once".into()); }
    }
    if pairs.iter().filter(|(name, _)| name == "scope").count() > 1 { return Err("OAuth scope must be supplied once".into()); }
    let values: HashMap<_, _> = pairs.into_iter().collect();
    if values.get("client_id").is_none_or(|value| value.trim().is_empty() || value.len() > 4096) { return Err("Invalid OAuth client ID".into()); }
    if values.get("state").map(|v| v.as_ref()) != Some(expected_state) || values.get("redirect_uri").map(|v| v.as_ref()) != Some(redirect.as_str()) || values.get("response_type").map(|v| v.as_ref()) != Some("code") || values.get("code_challenge_method").map(|v| v.as_ref()) != Some("S256") || values.get("code_challenge").is_none_or(|v| v.len() != 43 || !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) { return Err("Invalid OAuth PKCE parameters".into()); }
    Ok(url)
}
#[cfg(windows)]
fn open_browser(url: &Url) -> Result<(), String> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let value: Vec<u16> = url.as_str().encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), value.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    if result as isize <= 32 { return Err("Could not open the system browser for OAuth".into()); }
    Ok(())
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_browser(url: &Url) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    // Pass the validated HTTP(S) URL as one argument; never invoke a shell.
    let mut child = std::process::Command::new(program).arg(url.as_str())
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()
        .map_err(|_| "Could not launch the system browser for OAuth")?;
    // xdg-open may stay alive until a browser exits; don't block the callback
    // listener or its timeout. Reap the launcher separately to avoid zombies.
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn open_browser(_: &Url) -> Result<(), String> { Err("This operating system has no supported OAuth browser launcher".into()) }

enum Callback { Ignore, Code(String), Error }
fn callback(request: &str, redirect: &Url, state: &str) -> Callback {
    let mut parts = request.lines().next().unwrap_or("").split_whitespace();
    if parts.next() != Some("GET") { return Callback::Ignore; }
    let Some(target) = parts.next() else { return Callback::Ignore; };
    if !target.starts_with('/') || target.starts_with("//") { return Callback::Ignore; }
    let Ok(url) = redirect.join(target) else { return Callback::Ignore; };
    if url.origin() != redirect.origin() || url.fragment().is_some() || url.path() != redirect.path() { return Callback::Ignore; }
    let pairs: Vec<_> = url.query_pairs().collect();
    // Reject duplicates rather than choosing a potentially ambiguous state or code.
    let values = |key: &str| pairs.iter().filter(|(k, _)| k == key).map(|(_, v)| v.as_ref()).collect::<Vec<_>>();
    if values("state").as_slice() != [state] { return Callback::Ignore; }
    if !values("error").is_empty() { return Callback::Error; }
    let codes = values("code");
    if codes.len() == 1 && !codes[0].is_empty() && codes[0].len() <= 4096 { Callback::Code(codes[0].into()) } else { Callback::Ignore }
}
async fn handle(mut stream: TcpStream, redirect: &Url, state: &str) -> Result<Callback, String> {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0u8; 1024];
        let count = stream.read(&mut chunk).await.map_err(|_| "OAuth callback could not be read")?;
        if count == 0 { return Ok(Callback::Ignore); }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 8192 { return Ok(Callback::Ignore); }
        if bytes.windows(4).any(|w| w == b"\r\n\r\n") { break; }
    }
    let result = callback(std::str::from_utf8(&bytes).unwrap_or(""), redirect, state);
    let (status, text) = match &result { Callback::Code(_) => ("200 OK", "Authorization received. You can close this tab and return to Reqmas."), Callback::Error => ("400 Bad Request", "Authorization was declined. Return to Reqmas to try again."), Callback::Ignore => ("400 Bad Request", "This callback did not match the active authorization request.") };
    let body = format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>Reqmas OAuth</title></head><body><h1>Reqmas</h1><p>{text}</p></body></html>");
    let reply = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(reply.as_bytes()).await;
    Ok(result)
}
async fn listen(listener: TcpListener, redirect: &Url, state: &str) -> Result<String, String> {
    loop {
        let (stream, peer) = listener.accept().await.map_err(|_| "OAuth callback listener failed")?;
        if !peer.ip().is_loopback() { continue; }
        match tokio::time::timeout(Duration::from_secs(3), handle(stream, redirect, state)).await {
            Ok(Ok(Callback::Code(code))) => return Ok(code),
            Ok(Ok(Callback::Error)) => return Err("OAuth authorization was declined by the provider".into()),
            _ => {},
        }
    }
}
async fn authorization_session(receiver: oneshot::Receiver<()>, redirect: &Url, authorization: &Url, state: &str, open: impl FnOnce(&Url) -> Result<(), String>) -> Result<String, String> {
    tokio::select! {
        biased;
        _ = receiver => Err("OAuth cancelled".into()),
        value = async {
            let listener = TcpListener::bind(("127.0.0.1", redirect.port().unwrap())).await.map_err(|_| "OAuth callback port is already in use. Choose another Redirect URI port and register it with the provider.")?;
            open(authorization)?;
            tokio::time::timeout(Duration::from_secs(120), listen(listener, redirect, state)).await.unwrap_or_else(|_| Err("OAuth authorization timed out after 120 seconds".into()))
        } => value,
    }
}
#[tauri::command]
pub async fn oauth_authorize(authorization_url: String, redirect_uri: String, state: String, session_id: String, sessions: tauri::State<'_, OAuthSessions>) -> Result<String, String> {
    if state.len() < 32 || state.len() > 128 || !state.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') || session_id.is_empty() || session_id.len() > 128 { return Err("Invalid OAuth session".into()); }
    let redirect = redirect_url(&redirect_uri)?;
    let authorization = checked_authorization(&authorization_url, &redirect, &state)?;
    let receiver = {
        let mut guard = sessions.0.lock().map_err(|_| "OAuth session lock failed")?;
        guard.cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(60));
        if guard.cancelled.remove(&session_id).is_some() { return Err("OAuth cancelled".into()); }
        if guard.running.len() >= 8 || guard.running.contains_key(&session_id) { return Err("Another OAuth session is already running".into()); }
        let (sender, receiver) = oneshot::channel(); guard.running.insert(session_id.clone(), sender); receiver
    };
    let result = authorization_session(receiver, &redirect, &authorization, &state, open_browser).await;
    if let Ok(mut guard) = sessions.0.lock() { guard.running.remove(&session_id); }
    result
}
#[tauri::command]
pub fn cancel_oauth(session_id: String, sessions: tauri::State<'_, OAuthSessions>) {
    if let Ok(mut guard) = sessions.0.lock() {
        if let Some(sender) = guard.running.remove(&session_id) { let _ = sender.send(()); }
        else if session_id.len() <= 128 {
            guard.cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(60));
            if guard.cancelled.len() < 1000 { guard.cancelled.insert(session_id, Instant::now()); }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_non_loopback_and_ambiguous_callbacks() {
        assert!(redirect_url("https://127.0.0.1:58809/cb").is_err());
        assert!(redirect_url("http://localhost:58809/cb").is_err());
        assert!(redirect_url("http://127.0.0.1/cb").is_err());
        assert!(redirect_url("http://127.0.0.1:0/cb").is_err());
        let redirect = redirect_url("http://127.0.0.1:58809/cb").unwrap();
        for input in ["GET /cb?state=wrong&code=secret HTTP/1.1", "GET /cb?state=right&state=wrong&code=secret HTTP/1.1", "GET //evil.test/cb?state=right&code=secret HTTP/1.1", "GET /\\evil.test/cb?state=right&code=secret HTTP/1.1", "GET /cb?state=right&code=secret#fragment HTTP/1.1", "POST /cb?state=right&code=secret HTTP/1.1"] { assert!(matches!(callback(input, &redirect, "right"), Callback::Ignore)); }
        assert!(matches!(callback("GET /cb?state=right&code=one HTTP/1.1", &redirect, "right"), Callback::Code(code) if code == "one"));
        assert!(matches!(callback("GET /cb?state=right&error=denied HTTP/1.1", &redirect, "right"), Callback::Error));
    }
    #[test] fn authorization_requires_unambiguous_pkce_parameters() {
        let redirect = redirect_url("http://127.0.0.1:58809/cb").unwrap();
        let mut authorization = Url::parse("https://login.example.test/authorize").unwrap();
        authorization.query_pairs_mut().extend_pairs([("state", "test-state"), ("redirect_uri", redirect.as_str()), ("response_type", "code"), ("code_challenge_method", "S256"), ("code_challenge", &"x".repeat(43)), ("client_id", "audit-client")]);
        assert!(checked_authorization(authorization.as_str(), &redirect, "test-state").is_ok());
        for key in ["state", "redirect_uri", "response_type", "code_challenge_method", "code_challenge", "client_id", "scope"] {
            let mut duplicate = authorization.clone(); if key == "scope" { duplicate.query_pairs_mut().append_pair("scope", "one"); }
            duplicate.query_pairs_mut().append_pair(key, "conflicting"); assert!(checked_authorization(duplicate.as_str(), &redirect, "test-state").is_err());
        }
        assert!(checked_authorization(&"x".repeat(32769), &redirect, "test-state").is_err());
    }
    #[tokio::test] async fn early_cancel_never_opens_browser_and_listening_cancel_releases_port() {
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap(); let port = socket.local_addr().unwrap().port(); drop(socket);
        let redirect = redirect_url(&format!("http://127.0.0.1:{port}/cb")).unwrap(); let authorization = Url::parse("https://login.example.test/").unwrap();
        let (sender, receiver) = oneshot::channel(); sender.send(()).unwrap();
        assert_eq!(authorization_session(receiver, &redirect, &authorization, "state", |_| panic!("Cancelled authorization must not open a browser")).await.unwrap_err(), "OAuth cancelled");
        let (sender, receiver) = oneshot::channel();
        let (result, ()) = tokio::join!(authorization_session(receiver, &redirect, &authorization, "state", |_| Ok(())), async { tokio::time::sleep(Duration::from_millis(20)).await; sender.send(()).unwrap(); });
        assert_eq!(result.unwrap_err(), "OAuth cancelled"); assert!(TcpListener::bind(("127.0.0.1", port)).await.is_ok());
    }
    #[tokio::test] async fn loopback_receives_exact_code_with_matching_state() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let redirect = redirect_url(&format!("http://127.0.0.1:{}/cb", listener.local_addr().unwrap().port())).unwrap();
        let endpoint = format!("{redirect}?state=test-state&code=one%2Btwo");
        let (code, response) = tokio::join!(listen(listener, &redirect, "test-state"), reqwest::get(endpoint));
        assert_eq!(code.unwrap(), "one+two"); assert!(response.unwrap().status().is_success());
    }
}
