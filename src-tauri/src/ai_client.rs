use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProxyRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub proxy_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProxyResponse {
    pub status: u16,
    pub body: String,
}

fn build_client(proxy_url: Option<&str>, timeout_secs: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs));

    if let Some(proxy_str) = proxy_url {
        let trimmed = proxy_str.trim();
        if !trimmed.is_empty() {
            let proxy = reqwest::Proxy::all(trimmed)
                .map_err(|e| format!("Invalid proxy URL '{}': {}", trimmed, e))?;
            builder = builder.proxy(proxy);
        }
    }

    builder.build().map_err(|e| e.to_string())
}

fn format_reqwest_error(e: reqwest::Error) -> String {
    let mut detail = e.to_string();
    let mut source = std::error::Error::source(&e);
    while let Some(s) = source {
        detail.push_str(&format!(" (caused by: {})", s));
        source = std::error::Error::source(s);
    }
    format!("AI connection failed: {}", detail)
}

#[tauri::command]
pub async fn ai_stream_proxy(
    request: AiProxyRequest,
    channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let client = build_client(request.proxy_url.as_deref(), 120)?;

    let mut req = match request.method.to_uppercase().as_str() {
        "POST" => client.post(&request.url),
        "GET" => client.get(&request.url),
        _ => client.post(&request.url),
    };

    for (k, v) in request.headers {
        req = req.header(k, v);
    }

    if let Some(b) = request.body {
        req = req.body(b);
    }

    let mut resp = req.send().await.map_err(format_reqwest_error)?;
    let status = resp.status();
    if !status.is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status.as_u16(), err_text));
    }

    let mut byte_buf: Vec<u8> = Vec::with_capacity(16 * 1024);

    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Stream read error: {}", e))? {
        byte_buf.extend_from_slice(&chunk);

        match std::str::from_utf8(&byte_buf) {
            Ok(valid_str) => {
                if !valid_str.is_empty() {
                    channel.send(valid_str.to_string()).map_err(|e| format!("Channel send error: {}", e))?;
                }
                byte_buf.clear();
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let valid_str = match std::str::from_utf8(&byte_buf[..valid_up_to]) {
                        Ok(s) => s,
                        Err(_) => unreachable!(),
                    };
                    channel.send(valid_str.to_string()).map_err(|e| format!("Channel send error: {}", e))?;
                    byte_buf.drain(..valid_up_to);
                }

                // If error_len is Some, there's truly invalid data, not just an incomplete sequence
                if let Some(err_len) = err.error_len() {
                    let lossy = String::from_utf8_lossy(&byte_buf[..err_len]).to_string();
                    channel.send(lossy).map_err(|e| format!("Channel send error: {}", e))?;
                    byte_buf.drain(..err_len);
                }
            }
        }
    }

    // Flush any trailing bytes
    if !byte_buf.is_empty() {
        let trailing = String::from_utf8_lossy(&byte_buf).to_string();
        channel.send(trailing).map_err(|e| format!("Channel send error: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn ai_fetch_proxy(request: AiProxyRequest) -> Result<AiProxyResponse, String> {
    let client = build_client(request.proxy_url.as_deref(), 20)?;

    let mut req = match request.method.to_uppercase().as_str() {
        "POST" => client.post(&request.url),
        "GET" => client.get(&request.url),
        _ => client.post(&request.url),
    };

    for (k, v) in request.headers {
        req = req.header(k, v);
    }

    if let Some(b) = request.body {
        req = req.body(b);
    }

    let resp = req.send().await.map_err(format_reqwest_error)?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();

    Ok(AiProxyResponse { status, body })
}
