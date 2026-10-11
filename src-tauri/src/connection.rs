use serde::Deserialize;

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionOptions {
    pub proxy_url: Option<String>,
    pub proxy_username: Option<String>,
    pub proxy_password: Option<String>,
    pub ca_pem: Option<String>,
    pub client_cert_pem: Option<String>,
    pub client_key_pem: Option<String>,
}

fn nonempty(value: &Option<String>) -> Option<&str> { value.as_deref().filter(|value| !value.trim().is_empty()) }

pub fn configure(mut builder: reqwest::ClientBuilder, options: Option<&ConnectionOptions>) -> Result<reqwest::ClientBuilder, String> {
    let Some(options) = options else { return Ok(builder); };
    for (value, limit, name) in [(&options.proxy_url, 4096, "Proxy URL"), (&options.proxy_username, 4096, "Proxy username"), (&options.proxy_password, 4096, "Proxy password"), (&options.ca_pem, 512 * 1024, "Custom CA bundle"), (&options.client_cert_pem, 512 * 1024, "Client certificate"), (&options.client_key_pem, 128 * 1024, "Client private key")] {
        if value.as_ref().is_some_and(|value| value.len() > limit) { return Err(format!("{name} exceeds its size limit")); }
    }
    if let Some(proxy_url) = nonempty(&options.proxy_url) {
        let url = reqwest::Url::parse(proxy_url.trim()).map_err(|_| "Proxy URL must be a valid HTTP or HTTPS URL")?;
        if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() { return Err("Proxy URL must use HTTP or HTTPS and include a host".into()); }
        if !url.username().is_empty() || url.password().is_some() { return Err("Enter proxy credentials in the separate username and password fields".into()); }
        if url.query().is_some() || url.fragment().is_some() || url.path() != "/" { return Err("Proxy URL must contain only a scheme, host and optional port".into()); }
        let mut proxy = reqwest::Proxy::all(url).map_err(|_| "Unable to configure the HTTP proxy")?;
        if let Some(username) = nonempty(&options.proxy_username) { proxy = proxy.basic_auth(username, options.proxy_password.as_deref().unwrap_or("")); }
        else if nonempty(&options.proxy_password).is_some() { return Err("Proxy password requires a proxy username".into()); }
        builder = builder.no_proxy().proxy(proxy);
    } else if nonempty(&options.proxy_username).is_some() || nonempty(&options.proxy_password).is_some() { return Err("Proxy credentials require a proxy URL".into()); }
    if let Some(pem) = nonempty(&options.ca_pem) {
        let certificates = reqwest::Certificate::from_pem_bundle(pem.as_bytes()).map_err(|_| "Custom CA must be a valid PEM certificate bundle")?;
        if certificates.is_empty() { return Err("Custom CA bundle contains no PEM certificates".into()); }
        for certificate in certificates { builder = builder.add_root_certificate(certificate); }
    }
    match (nonempty(&options.client_cert_pem), nonempty(&options.client_key_pem)) {
        (Some(certificate), Some(key)) => {
            let pem = format!("{certificate}\n{key}\n");
            let identity = reqwest::Identity::from_pem(pem.as_bytes()).map_err(|_| "Client identity requires a valid PEM certificate and unencrypted matching private key")?;
            builder = builder.identity(identity);
        }
        (None, None) => {}
        _ => return Err("Client certificate and private key must be supplied together".into()),
    }
    Ok(builder)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn invalid(options: ConnectionOptions) -> String { configure(reqwest::Client::builder(), Some(&options)).expect_err("Expected invalid connection options") }
    #[test]
    fn proxy_rejects_unsupported_urls_embedded_credentials_and_incomplete_options() {
        for url in ["file:///private", "socks5://localhost:1080", "not a url", "http://example.test/path", "http://example.test/?token=secret", "http://example.test/#fragment"] { assert!(!invalid(ConnectionOptions { proxy_url: Some(url.into()), ..Default::default() }).contains(url)); }
        let secret_url = "http://user:secret@example.test:8080";
        let error = invalid(ConnectionOptions { proxy_url: Some(secret_url.into()), ..Default::default() }); assert!(!error.contains("secret")); assert!(error.contains("separate"));
        assert!(invalid(ConnectionOptions { proxy_password: Some("private".into()), ..Default::default() }).contains("URL"));
        assert!(invalid(ConnectionOptions { proxy_url: Some("http://localhost:8080".into()), proxy_password: Some("private".into()), ..Default::default() }).contains("username"));
        assert!(configure(reqwest::Client::builder(), Some(&ConnectionOptions { proxy_url: Some("http://localhost:8080".into()), proxy_username: Some("user".into()), proxy_password: Some("password".into()), ..Default::default() })).unwrap().build().is_ok());
    }
    #[test]
    fn certificate_errors_do_not_include_sensitive_material_and_options_have_bounds() {
        assert!(invalid(ConnectionOptions { ca_pem: Some("invalid-ca-secret-content".into()), ..Default::default() }).contains("certificate"));
        assert!(!invalid(ConnectionOptions { client_cert_pem: Some("certificate".into()), client_key_pem: Some("secret-private-key".into()), ..Default::default() }).contains("secret-private-key"));
        assert!(invalid(ConnectionOptions { client_cert_pem: Some("certificate".into()), ..Default::default() }).contains("together"));
        assert!(invalid(ConnectionOptions { client_key_pem: Some("key".into()), ..Default::default() }).contains("together"));
        assert!(invalid(ConnectionOptions { ca_pem: Some("x".repeat(512 * 1024 + 1)), ..Default::default() }).contains("size limit"));
        assert!(configure(reqwest::Client::builder(), Some(&ConnectionOptions::default())).unwrap().build().is_ok());
    }
}
