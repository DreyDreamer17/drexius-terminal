//! Pop-out terminal pane native window management for multi-monitor workspaces.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PopoutWindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn window_label_for_pane(pane_id: &str) -> String {
    let clean: String = pane_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("popout-{clean}")
}

#[tauri::command]
pub fn popout_open_window(
    app: AppHandle,
    pane_id: String,
    title: String,
    url_query: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> AppResult<()> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let label = window_label_for_pane(&pane_id);
        if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.unminimize();
            let _ = existing.show();
            let _ = existing.set_focus();
            return Ok(());
        }

        let target_url = if url_query.starts_with('?') {
            format!("index.html{url_query}")
        } else {
            format!("index.html?{url_query}")
        };

        let w = width.unwrap_or(920.0).max(480.0);
        let h = height.unwrap_or(620.0).max(320.0);

        let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(target_url.into()))
            .title(&title)
            .inner_size(w, h)
            .min_inner_size(480.0, 320.0);

        if let (Some(px), Some(py)) = (x, y) {
            if px.is_finite() && py.is_finite() {
                builder = builder.position(px, py);
            }
        }

        builder
            .build()
            .map_err(|e| AppError::Other(format!("failed to open pop-out window: {e}")))?;
        Ok(())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, pane_id, title, url_query, x, y, width, height);
        Err(AppError::Other("Pop-out windows are only supported on desktop".into()))
    }
}

#[tauri::command]
pub fn popout_close_window(app: AppHandle, pane_id: String) -> AppResult<()> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let label = window_label_for_pane(&pane_id);
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.close();
        }
        Ok(())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, pane_id);
        Ok(())
    }
}

#[tauri::command]
pub fn popout_get_bounds(app: AppHandle, pane_id: String) -> AppResult<Option<PopoutWindowBounds>> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let label = window_label_for_pane(&pane_id);
        let Some(win) = app.get_webview_window(&label) else {
            return Ok(None);
        };
        let scale = win.scale_factor().unwrap_or(1.0).max(0.5);
        let pos = win.outer_position().ok();
        let size = win.inner_size().ok();
        match (pos, size) {
            (Some(p), Some(s)) => Ok(Some(PopoutWindowBounds {
                x: (p.x as f64 / scale).round(),
                y: (p.y as f64 / scale).round(),
                width: (s.width as f64 / scale).round(),
                height: (s.height as f64 / scale).round(),
            })),
            _ => Ok(None),
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, pane_id);
        Ok(None)
    }
}

#[tauri::command]
pub fn popout_list_windows(app: AppHandle) -> AppResult<Vec<String>> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let mut out = Vec::new();
        for label in app.webview_windows().keys() {
            if let Some(rest) = label.strip_prefix("popout-") {
                out.push(rest.to_string());
            }
        }
        Ok(out)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}
