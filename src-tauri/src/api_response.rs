//! Bounded HTTP reads: displaying 400 characters must not require downloading an
//! arbitrarily large error page first. Limits apply even without Content-Length.
use reqwest::Response;

const JSON_LIMIT: usize = 4 * 1024 * 1024;
const ERROR_LIMIT: usize = 4096;

async fn read_bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(format!("接口响应超过大小上限（{limit} 字节）。"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.without_url().to_string())? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(format!("接口响应超过大小上限（{limit} 字节）。"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) async fn read_json(response: Response) -> Result<serde_json::Value, String> {
    let bytes = read_bounded(response, JSON_LIMIT).await?;
    serde_json::from_slice(&bytes).map_err(|error| format!("接口未返回有效的 JSON 响应：{error}"))
}

pub(crate) async fn error_detail(mut response: Response) -> String {
    let mut bytes = Vec::new();
    while bytes.len() < ERROR_LIMIT {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let count = chunk.len().min(ERROR_LIMIT - bytes.len());
                bytes.extend_from_slice(&chunk[..count]);
            }
            _ => break,
        }
    }
    String::from_utf8_lossy(&bytes).chars().take(400).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, thread, time::Duration};

    fn response(raw: String) -> Response {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut headers = Vec::new();
            let mut byte = [0];
            while socket.read_exact(&mut byte).is_ok() {
                headers.push(byte[0]);
                if headers.ends_with(b"\r\n\r\n") { break; }
            }
            // Early rejection can legitimately close the connection mid-write.
            let _ = socket.write_all(raw.as_bytes());
        });
        tauri::async_runtime::block_on(async {
            reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap()
                .get(format!("http://{address}")).send().await.unwrap()
        })
    }

    #[test]
    fn rejects_oversize_declared_and_chunked_bodies() {
        for raw in [
            "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n".to_string(),
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\n1234\r\n4\r\n5678\r\n0\r\n\r\n".to_string(),
        ] {
            let result = tauri::async_runtime::block_on(read_bounded(response(raw), 7));
            assert!(result.unwrap_err().contains("大小上限"));
        }
    }

    #[test]
    fn accepts_exact_limit_and_limits_error_preview() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n1234";
        assert_eq!(tauri::async_runtime::block_on(read_bounded(response(raw.into()), 4)).unwrap(), b"1234");
        let body = "x".repeat(ERROR_LIMIT * 2);
        let raw = format!("HTTP/1.1 500 Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        assert_eq!(tauri::async_runtime::block_on(error_detail(response(raw))).len(), 400);
    }
}
