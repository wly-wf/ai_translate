//! Shared connection pools; API redirects are deliberately disabled so neither
//! credentials nor source text can be forwarded to another origin or to HTTP.
use std::{sync::{Mutex, OnceLock}, time::Duration};
use reqwest::Client;
use crate::{custom_proxy_url, ProxyMode, UserPreferences};

static CLIENT: OnceLock<Mutex<Option<(String, Client)>>> = OnceLock::new();

pub(crate) fn build_http_client(
    preferences: &UserPreferences,
    timeout: Duration,
) -> Result<Client, String> {
    let cache_key = serde_json::to_string(&(
        &preferences.proxy_mode, &preferences.proxy_type, &preferences.proxy_url,
        &preferences.proxy_host, &preferences.proxy_port, &preferences.proxy_username,
        &preferences.proxy_password, &preferences.proxy_bypass, timeout.as_millis(),
    )).map_err(|error| error.to_string())?;
    let cache = CLIENT.get_or_init(|| Mutex::new(None));
    let mut cached = cache.lock().unwrap_or_else(|error| error.into_inner());
    if let Some((key, client)) = cached.as_ref() {
        if key == &cache_key { return Ok(client.clone()); }
    }
    let mut builder = Client::builder().timeout(timeout)
        .redirect(reqwest::redirect::Policy::none());
    builder = match preferences.proxy_mode {
        ProxyMode::System => builder,
        ProxyMode::Disabled => builder.no_proxy(),
        ProxyMode::Custom => {
            let proxy_url = custom_proxy_url(preferences)?;
            let mut proxy = reqwest::Proxy::all(&proxy_url)
                .map_err(|_| "无法使用该代理地址，请检查协议、主机和端口。".to_string())?;
            if !preferences.proxy_bypass.trim().is_empty() {
                proxy = proxy.no_proxy(reqwest::NoProxy::from_string(&preferences.proxy_bypass));
            }
            builder.proxy(proxy)
        }
    };
    let client = builder.build().map_err(|error| format!("无法初始化网络连接：{error}"))?;
    *cached = Some((cache_key, client.clone()));
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, thread};

    fn server(status: &str, headers: &str, body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let task = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length:")).map(|value| value.trim().parse().unwrap()).unwrap_or(0);
                    if bytes.len() >= end + 4 + length { break; }
                }
            }
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        });
        (url, task)
    }

    #[test]
    fn api_redirects_do_not_forward_credentials_or_source_text() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let (url, task) = server("307 Temporary Redirect", &format!("Location: http://{}/stolen\r\n", target.local_addr().unwrap()), "");
        tauri::async_runtime::block_on(async {
            let client = build_http_client(&UserPreferences::default(), Duration::from_secs(2)).unwrap();
            let response = client.post(url).header("api-key", "dummy-secret").body("private source").send().await.unwrap();
            assert_eq!(response.status(), 307);
        });
        let request = task.join().unwrap();
        assert!(request.contains("dummy-secret"));
        assert_eq!(target.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn connection_test_rejects_success_status_without_model_output() {
        for body in ["<html>login</html>", r#"{"error":"invalid key"}"#, r#"{"choices":[]}"#] {
            let (url, task) = server("200 OK", "", body);
            let result = tauri::async_runtime::block_on(crate::send_connection_test("openai", "dummy", &url, "test-model", &UserPreferences::default()));
            assert!(result.is_err(), "unexpected success for {body}");
            task.join().unwrap();
        }
    }
}

