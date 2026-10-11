#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
mod connection;
mod workspace_store;
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
mod secure_storage;
mod oauth_flow;
mod updates;
use serde::{Deserialize, Serialize};
use base64::Engine;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[derive(Default)]
struct PendingRequests {
    running: HashMap<String, oneshot::Sender<()>>,
    cancelled: HashMap<String, Instant>,
}
type Pending = Mutex<PendingRequests>;
fn register_request(request_id: &str, pending: &Pending) -> Result<oneshot::Receiver<()>, String> {
    let mut pending = pending.lock().map_err(|e| e.to_string())?;
    pending.cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(60));
    if pending.cancelled.remove(request_id).is_some() { return Err("Request cancelled".into()); }
    let (tx, rx) = oneshot::channel();
    pending.running.insert(request_id.into(), tx);
    Ok(rx)
}
fn cancel_pending(request_id: String, pending: &Pending) {
    if let Ok(mut pending) = pending.lock() {
        if let Some(tx) = pending.running.remove(&request_id) { let _ = tx.send(()); }
        else {
            pending.cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(60));
            if pending.cancelled.len() >= 1000 {
                if let Some(oldest) = pending.cancelled.iter().min_by_key(|(_, time)| **time).map(|(id, _)| id.clone()) { pending.cancelled.remove(&oldest); }
            }
            pending.cancelled.insert(request_id, Instant::now());
        }
    }
}
#[derive(Deserialize, Default)]
struct ApiRequest {
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    #[serde(default, rename = "bodyBase64")]
    body_base64: Option<String>,
    #[serde(default, rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(default, rename = "followRedirects")]
    follow_redirects: Option<bool>,
    #[serde(default)]
    connection: Option<connection::ConnectionOptions>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Redirect {
    from: String,
    to: String,
    status: u16,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    status: u16,
    status_text: String,
    duration: u128,
    size: usize,
    headers: HashMap<String, String>,
    body: String,
    body_base64: String,
    binary: bool,
    headers_duration: u128,
    download_duration: u128,
    redirects: Vec<Redirect>,
    set_cookies: Vec<String>,
    url: String,
}

const MAX_RESPONSE_BYTES: usize = 100 * 1024 * 1024;
async fn response_bytes_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let too_large = || format!("Response exceeds the {} MiB size limit", limit / (1024 * 1024));
    if response.content_length().is_some_and(|size| size > limit as u64) { return Err(too_large()); }
    let mut bytes = Vec::with_capacity(response.content_length().unwrap_or(0).min(1024 * 1024) as usize);
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len().checked_add(chunk.len()).is_none_or(|size| size > limit) { return Err(too_large()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn execute(request: ApiRequest) -> Result<ApiResponse, String> {
    let started = Instant::now();
    let url = reqwest::Url::parse(&request.url).map_err(|e| e.to_string())?;
    if !["http", "https"].contains(&url.scheme()) {
        return Err("Only HTTP and HTTPS are supported".into());
    }
    if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
        .contains(&request.method.as_str())
    {
        return Err("Unsupported method".into());
    }
    let method =
        reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|e| e.to_string())?;
    let redirects = Arc::new(Mutex::new(Vec::new()));
    let redirect_trace = Arc::clone(&redirects);
    let follow_redirects = request.follow_redirects != Some(false);
    let client = connection::configure(reqwest::Client::builder()
        .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(30000).clamp(100, 300000)))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if let Ok(mut trace) = redirect_trace.lock() {
                trace.push(Redirect { from: attempt.previous().last().map(|url| url.to_string()).unwrap_or_default(), to: attempt.url().to_string(), status: attempt.status().as_u16() });
            }
            if !follow_redirects { attempt.stop() }
            else if attempt.previous().len() > 10 { attempt.error("Too many redirects (limit 10)") }
            else { attempt.follow() }
        })), request.connection.as_ref())?
        .build()
        .map_err(|e| e.to_string())?;
    let mut builder = client.request(method, url);
    for (key, value) in request.headers {
        builder = builder.header(key, value);
    }
    if request.method != "GET" && request.method != "HEAD" {
        if let Some(body) = request.body_base64 {
            builder = builder.body(base64::engine::general_purpose::STANDARD.decode(body).map_err(|e| e.to_string())?);
        } else if let Some(body) = request.body {
            builder = builder.body(body);
        }
    }
    let response = builder.send().await.map_err(network_error)?;
    let received_headers = started.elapsed();
    let status = response.status();
    let final_url = response.url().to_string();
    let set_cookies = response.headers().get_all(reqwest::header::SET_COOKIE).iter().filter_map(|v| v.to_str().ok().map(String::from)).collect();
    let mut headers = HashMap::<String, String>::new();
    for (key, value) in response.headers().iter() {
        let value = value.to_str().unwrap_or("");
        headers.entry(key.to_string()).and_modify(|combined| {
            combined.push_str(if key == reqwest::header::SET_COOKIE { "\n" } else { ", " });
            combined.push_str(value);
        }).or_insert_with(|| value.to_string());
    }
    let bytes = response_bytes_limited(response, MAX_RESPONSE_BYTES).await?;
    let duration = started.elapsed();
    let content_type = headers.get("content-type").map(String::as_str).unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase();
    let text_type = content_type.starts_with("text/") || ["json", "xml", "javascript", "yaml", "x-www-form-urlencoded", "graphql"].iter().any(|kind| content_type.contains(kind));
    let binary_type = ["image/", "audio/", "video/", "font/"].iter().any(|kind| content_type.starts_with(kind)) || ["octet-stream", "pdf", "zip", "compressed", "protobuf", "wasm"].iter().any(|kind| content_type.contains(kind));
    let binary = !text_type && (binary_type || std::str::from_utf8(&bytes).is_err() || bytes.iter().any(|byte| *byte < 32 && ![9, 10, 13].contains(byte)));
    let redirect_list = std::mem::take(&mut *redirects.lock().map_err(|e| e.to_string())?);
    Ok(ApiResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").into(),
        duration: duration.as_millis(),
        size: bytes.len(),
        headers,
        body: if binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() },
        body_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        binary,
        headers_duration: received_headers.as_millis(),
        download_duration: duration.saturating_sub(received_headers).as_millis(),
        redirects: redirect_list,
        set_cookies,
        url: final_url,
    })
}
fn network_error(error: reqwest::Error) -> String {
    let kind = if error.is_timeout() { "Request timed out" } else if error.is_connect() { "Connection failed" } else if error.is_redirect() { "Redirect failed" } else if error.is_body() { "Response body failed" } else { "HTTP request failed" };
    let error = error.without_url();
    let mut detail = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source { detail.push_str(": "); detail.push_str(&cause.to_string()); source = cause.source(); }
    format!("{kind}: {detail}")
}
#[tauri::command]
async fn send_request(
    request_id: String,
    request: ApiRequest,
    pending: tauri::State<'_, Pending>,
) -> Result<ApiResponse, String> {
    let rx = register_request(&request_id, &pending)?;
    let result = tokio::select! { result = execute(request) => result, _ = rx => Err("Request cancelled".into()) };
    pending
        .lock()
        .map_err(|e| e.to_string())?
        .running.remove(&request_id);
    result
}
#[tauri::command]
fn cancel_request(request_id: String, pending: tauri::State<'_, Pending>) {
    cancel_pending(request_id, &pending);
}
fn main() {
    tauri::Builder::default()
        .manage(Pending::default())
        .setup(|app| {
            use tauri::Manager;
            app.manage(workspace_store::WorkspaceLock::initialize(app.handle()));
            Ok(())
        })
        .manage(oauth_flow::OAuthSessions::default())
        .manage(updates::PendingUpdate::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![send_request, cancel_request, workspace_store::load_workspace, workspace_store::save_workspace, workspace_store::list_workspace_backups, workspace_store::read_workspace_backup, workspace_store::restore_workspace_backup, oauth_flow::oauth_authorize, oauth_flow::cancel_oauth, updates::check_for_update, updates::install_update])
        .run(tauri::generate_context!())
        .expect("Unable to start Reqmas");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[tokio::test]
    async fn response_size_limit_checks_declared_and_streamed_bytes_and_accepts_exact_boundary() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for index in 0..3 {
                let (mut stream, _) = listener.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0u8; 2048]; assert!(stream.read(&mut request).unwrap() > 0);
                let response = match index {
                    0 => b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n".to_vec(),
                    1 => b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n11\r\n12345678901234567\r\n11\r\n12345678901234567\r\n0\r\n\r\n".to_vec(),
                    _ => b"HTTP/1.1 200 OK\r\nContent-Length: 32\r\nConnection: close\r\n\r\n12345678901234567890123456789012".to_vec(),
                };
                stream.write_all(&response).unwrap();
            }
        });
        let url = format!("http://{address}/"); let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert!(response_bytes_limited(client.get(&url).send().await.unwrap(), 32).await.unwrap_err().contains("size limit"));
        assert!(response_bytes_limited(client.get(&url).send().await.unwrap(), 32).await.unwrap_err().contains("size limit"));
        assert_eq!(response_bytes_limited(client.get(&url).send().await.unwrap(), 32).await.unwrap().len(), 32);
        server.join().unwrap();
    }
    #[tokio::test]
    async fn custom_ca_and_mtls_require_both_trust_and_a_valid_client_identity() {
        use rcgen::{BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose};
        use rustls::{pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer}, server::WebPkiClientVerifier, RootCertStore, ServerConfig, ServerConnection, StreamOwned};
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::CrlSign];
        let ca_key = KeyPair::generate().unwrap(); let ca = ca_params.self_signed(&ca_key).unwrap(); let issuer = Issuer::from_params(&ca_params, &ca_key);
        let server_key = KeyPair::generate().unwrap(); let mut server_params = CertificateParams::new(vec!["localhost".into(), "127.0.0.1".into()]).unwrap(); server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let server_cert = server_params.signed_by(&server_key, &issuer).unwrap();
        let client_key = KeyPair::generate().unwrap(); let mut client_params = CertificateParams::new(Vec::<String>::new()).unwrap(); client_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        let client_cert = client_params.signed_by(&client_key, &issuer).unwrap();
        let mut client_roots = RootCertStore::empty(); client_roots.add(ca.der().clone()).unwrap();
        let verifier = WebPkiClientVerifier::builder(Arc::new(client_roots)).build().unwrap();
        let config = Arc::new(ServerConfig::builder().with_client_cert_verifier(verifier).with_single_cert(vec![server_cert.der().clone(), ca.der().clone()], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(server_key.serialize_der()))).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let mut successes = 0;
            for _ in 0..3 {
                let (socket, _) = listener.accept().unwrap(); socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap(); socket.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut stream = StreamOwned::new(ServerConnection::new(Arc::clone(&config)).unwrap(), socket);
                let mut request = [0u8; 2048];
                if stream.read(&mut request).is_ok_and(|n| n > 0) { successes += 1; stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecure").unwrap(); stream.flush().unwrap(); }
            }
            successes
        });
        let make_request = |connection| ApiRequest { method: "GET".into(), url: format!("https://{address}/secure"), connection, timeout_ms: Some(5000), ..Default::default() };
        assert!(execute(make_request(None)).await.is_err());
        assert!(execute(make_request(Some(connection::ConnectionOptions { ca_pem: Some(ca.pem()), ..Default::default() }))).await.is_err());
        let response = execute(make_request(Some(connection::ConnectionOptions { ca_pem: Some(ca.pem()), client_cert_pem: Some(client_cert.pem()), client_key_pem: Some(client_key.serialize_pem()), ..Default::default() }))).await.unwrap();
        assert_eq!(response.body, "secure"); assert_eq!(server.join().unwrap(), 1);
    }
    #[tokio::test]
    async fn custom_proxy_receives_absolute_target_and_basic_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buffer = [0u8; 4096]; let n = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..n]).to_string();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy").unwrap(); request
        });
        let response = execute(ApiRequest { method: "GET".into(), url: "http://destination.example.test/v1?x=1".into(), connection: Some(connection::ConnectionOptions { proxy_url: Some(format!("http://{address}")), proxy_username: Some("audit-user".into()), proxy_password: Some("audit-password".into()), ..Default::default() }), ..Default::default() }).await.unwrap();
        let wire = server.join().unwrap(); assert!(wire.starts_with("GET http://destination.example.test/v1?x=1 HTTP/1.1"));
        assert!(wire.to_lowercase().contains("proxy-authorization: basic yxvkaXQtdXNlcjphdWRpdC1wYXNzd29yZA==".to_lowercase().as_str()));
        assert_eq!(response.body, "proxy");
    }
    #[tokio::test]
    async fn connection_errors_do_not_include_request_url_credentials_or_query_secrets() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap(); drop(listener);
        let error = execute(ApiRequest { method: "GET".into(), url: format!("http://synthetic-secret:synthetic-password@{address}/?token=synthetic-token"), timeout_ms: Some(200), ..Default::default() }).await.err().unwrap();
        for secret in ["synthetic-secret", "synthetic-password", "synthetic-token"] { assert!(!error.contains(secret)); }
    }
    #[tokio::test]
    async fn cancellation_before_registration_is_retained_and_running_requests_receive_the_signal() {
        let pending = Pending::default();
        cancel_pending("early".into(), &pending);
        assert!(matches!(register_request("early", &pending), Err(error) if error == "Request cancelled"));
        assert!(pending.lock().unwrap().running.is_empty());
        assert!(pending.lock().unwrap().cancelled.is_empty());
        let receiver = register_request("running", &pending).unwrap();
        cancel_pending("running".into(), &pending);
        assert!(receiver.await.is_ok());
        assert!(pending.lock().unwrap().running.is_empty());
        for i in 0..1100 { cancel_pending(format!("stale-{i}"), &pending); }
        assert!(pending.lock().unwrap().cancelled.len() <= 1000);
    }

    #[tokio::test]
    async fn preserves_repeated_response_header_values() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = [0u8; 2048]; assert!(stream.read(&mut request).unwrap() > 0);
            stream.write_all(b"HTTP/1.1 200 OK\r\nX-Tag: first\r\nX-Tag: second\r\nSet-Cookie: a=1; Path=/\r\nSet-Cookie: b=2; Path=/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let response = execute(ApiRequest { method: "GET".into(), url: format!("http://{address}/"), ..Default::default() }).await.unwrap();
        server.join().unwrap();
        assert_eq!(response.headers["x-tag"], "first, second");
        assert_eq!(response.headers["set-cookie"], "a=1; Path=/\nb=2; Path=/");
        assert_eq!(response.set_cookies.len(), 2);
    }

    #[tokio::test]
    async fn preserves_post_headers_body_and_http_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 2048];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0);
                received.extend_from_slice(&buffer[..n]);
                let text = String::from_utf8_lossy(&received);
                if let Some(header_end) = text.find("\r\n\r\n") {
                    let length: usize = text[..header_end]
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|s| s.parse().ok())
                        })
                        .unwrap_or(0);
                    if received.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"error\":true}").unwrap();
            String::from_utf8(received).unwrap()
        });
        let result = execute(ApiRequest {
            method: "POST".into(),
            url: format!("http://{address}/users?limit=1"),
            headers: HashMap::from([
                ("Content-Type".into(), "application/json".into()),
                ("X-Test".into(), "reqmas".into()),
            ]),
            body: Some("{\"name\":\"Alex\"}".into()),
            body_base64: None,
            ..Default::default()
        })
        .await
        .unwrap();
        let wire = server.join().unwrap();
        assert!(wire.starts_with("POST /users?limit=1 HTTP/1.1"));
        assert!(wire.to_lowercase().contains("x-test: reqmas"));
        assert!(wire.ends_with("{\"name\":\"Alex\"}"));
        assert_eq!(result.status, 404);
        assert_eq!(result.status_text, "Not Found");
        assert_eq!(result.body, "{\"error\":true}");
        assert_eq!(result.size, 14);
        assert_eq!(result.headers["content-type"], "application/json");
    }
    #[tokio::test]
    async fn rejects_non_http_urls_and_unsupported_methods() {
        assert!(execute(ApiRequest {
            method: "GET".into(),
            url: "file:///C:/private.txt".into(),
            headers: HashMap::new(),
            body: None, body_base64: None, ..Default::default()
        })
        .await
        .is_err());
        assert!(execute(ApiRequest {
            method: "TRACE".into(),
            url: "http://localhost/".into(),
            headers: HashMap::new(),
            body: None, body_base64: None, ..Default::default()
        })
        .await
        .is_err());
    }
    #[tokio::test]
    async fn sends_binary_bytes_and_returns_all_set_cookie_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut wire = Vec::new();
            let mut buffer = [0u8; 2048];
            loop {
                let n = stream.read(&mut buffer).unwrap(); assert!(n > 0);
                wire.extend_from_slice(&buffer[..n]);
                if wire.ends_with(&[0, 1, 2, 255]) { break; }
            }
            assert!(String::from_utf8_lossy(&wire).to_lowercase().contains("cookie: sid=test"));
            stream.write_all(b"HTTP/1.1 200 OK\r\nSet-Cookie: first=one; Path=/\r\nSet-Cookie: second=two; Path=/\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
        });
        let response = execute(ApiRequest { method: "POST".into(), url: format!("http://{address}/upload"), headers: HashMap::from([("Cookie".into(), "sid=test".into())]), body: None, body_base64: Some("AAEC/w==".into()), ..Default::default() }).await.unwrap();
        server.join().unwrap();
        assert_eq!(response.set_cookies.len(), 2);
        assert_eq!(response.url, format!("http://{address}/upload"));
        assert_eq!(response.body, "ok");
    }
    #[tokio::test]
    async fn respects_redirect_policy_and_custom_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for index in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut buffer = [0u8; 2048]; assert!(stream.read(&mut buffer).unwrap() > 0);
                if index < 2 { stream.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://{address}/target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap(); }
                else { stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap(); }
            }
        });
        let stopped = execute(ApiRequest { method: "GET".into(), url: format!("http://{address}/redirect"), follow_redirects: Some(false), ..Default::default() }).await.unwrap();
        assert_eq!(stopped.status, 302);
        assert_eq!(stopped.redirects.len(), 1);
        assert_eq!(stopped.redirects[0].status, 302);
        assert!(stopped.redirects[0].to.ends_with("/target"));
        let followed = execute(ApiRequest { method: "GET".into(), url: format!("http://{address}/redirect"), follow_redirects: Some(true), ..Default::default() }).await.unwrap();
        assert_eq!(followed.status, 200); assert!(followed.url.ends_with("/target"));
        assert_eq!(followed.redirects.len(), 1);
        assert_eq!(followed.body_base64, "b2s=");
        assert!(!followed.binary);
        assert!(followed.headers_duration <= followed.duration);
        server.join().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap();
        let slow = thread::spawn(move || { let (_stream, _) = listener.accept().unwrap(); thread::sleep(Duration::from_millis(350)); });
        let result = execute(ApiRequest { method: "GET".into(), url: format!("http://{address}/slow"), timeout_ms: Some(100), ..Default::default() }).await;
        assert!(result.is_err()); slow.join().unwrap();
    }
    #[tokio::test]
    async fn preserves_binary_response_bytes_for_download() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected = vec![0, 255, 13, 10, 128, 37, 80, 68, 70];
        let sent = expected.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048]; assert!(stream.read(&mut request).unwrap() > 0);
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=report.pdf\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", sent.len()).as_bytes()).unwrap();
            stream.write_all(&sent).unwrap();
        });
        let response = execute(ApiRequest { method: "GET".into(), url: format!("http://{address}/download"), ..Default::default() }).await.unwrap();
        server.join().unwrap();
        assert!(response.binary);
        assert!(response.body.is_empty());
        assert_eq!(response.size, expected.len());
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(response.body_base64).unwrap(), expected);
        assert_eq!(response.headers["content-disposition"], "attachment; filename=report.pdf");
    }
}
