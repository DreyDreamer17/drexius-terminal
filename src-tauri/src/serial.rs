//! Native serial-port (UART / RS-232 / USB-serial) support.
//!
//! Uses the `serialport` crate for cross-platform access to real serial
//! devices on Linux, macOS and Windows (replaces the previous hack of
//! shelling out to `picocom`/`minicom`/`tio`, which didn't work on Windows
//! or macOS without Homebrew/MacPorts, and didn't give us proper DTR/RTS
//! line control).
//!
//! Model mirrors `local_pty.rs`:
//!   • One OS thread per open port.
//!   • Port reads are done with a short timeout (100 ms) so we can notice
//!     a Close command promptly without busy-waiting.
//!   • UI commands (Write / Close) arrive over an `mpsc::channel`.
//!   • Output is base64-framed and pushed to the frontend over a
//!     `tauri::ipc::Channel` — byte-exact, binary-safe, identical to
//!     what PTY/SSH do, so the frontend can drop it straight into
//!     xterm.js.
//!
//! We reuse `local_pty::PtyEvent` because the event shape (connected/
//! output/cwd/disconnected) maps cleanly: we send the port path as
//! `cwd` so the status bar displays it.

use crate::error::{AppError, AppResult};
use crate::local_pty::PtyEvent;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use serde::Deserialize;
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialOpenRequest {
    pub port_name: String,
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default)]
    pub parity: String, // "none" | "odd" | "even" | "mark" | "space"
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    #[serde(default)]
    pub flow_control: String, // "none" | "software" | "hardware"
}

fn default_data_bits() -> u8 { 8 }
fn default_stop_bits() -> u8 { 1 }

fn parse_data_bits(b: u8) -> AppResult<DataBits> {
    match b {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err(AppError::Other(format!("Unsupported data bits: {b}"))),
    }
}

fn parse_stop_bits(b: u8) -> AppResult<StopBits> {
    match b {
        1 => Ok(StopBits::One),
        2 => Ok(StopBits::Two),
        _ => Err(AppError::Other(format!("Unsupported stop bits: {b}"))),
    }
}

fn parse_parity(p: &str) -> Parity {
    match p.to_ascii_lowercase().as_str() {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    }
}

fn parse_flow_control(f: &str) -> FlowControl {
    match f.to_ascii_lowercase().as_str() {
        "software" | "xonxoff" => FlowControl::Software,
        "hardware" | "rtscts" => FlowControl::Hardware,
        _ => FlowControl::None,
    }
}

enum Cmd {
    Write(Vec<u8>),
    Close,
    /// Re-apply DTR (e.g. after an Arduino auto-reset cycle); optional
    /// convenience for microcontroller work.
    PulseDtr,
}

struct SessionHandle {
    tx: Sender<Cmd>,
}

#[derive(Clone)]
pub struct SerialManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
}

impl Default for SerialManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl SerialManager {
    fn send(&self, session_id: &str, cmd: Cmd) -> AppResult<()> {
        let guard = self.sessions.lock();
        let h = guard
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.into()))?;
        h.tx.send(cmd).map_err(|_| AppError::SessionNotFound(session_id.into()))
    }
}

/// List available serial ports with friendly descriptions.
///
/// Returns the platform's enumeration plus a small set of well-known fallback
/// entries (Linux ttyUSB* / ttyACM* / ttyS*) so that ports that exist but
/// aren't surfaced by the backend (e.g. devices with broken udev metadata)
/// still appear. When running natively the user can always type a custom
/// port path in the modal.
#[tauri::command]
pub fn serial_list_ports() -> Vec<crate::vault::SerialPortInfo> {
    let mut ports = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Enumerate via the serialport crate — works across Linux/macOS/Windows.
    if let Ok(listing) = serialport::available_ports() {
        for p in listing {
            let description = if p.port_type == serialport::SerialPortType::Unknown {
                None
            } else {
                Some(format!("{:?}", p.port_type))
            };
            seen.insert(p.port_name.clone());
            ports.push(crate::vault::SerialPortInfo {
                port_name: p.port_name,
                description,
            });
        }
    }

    // Linux: add /dev/serial/by-id symlinks (descriptive, stable names).
    #[cfg(target_os = "linux")]
    {
        if let Ok(entries) = std::fs::read_dir("/dev/serial/by-id") {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(target) = std::fs::canonicalize(&path) {
                    let name = target.to_string_lossy().to_string();
                    let desc = entry.file_name().to_string_lossy().to_string();
                    if !seen.contains(&name) {
                        seen.insert(name.clone());
                        ports.push(crate::vault::SerialPortInfo {
                            port_name: name,
                            description: Some(desc),
                        });
                    }
                }
            }
        }
    }

    // Fallback: scan for common device nodes on Linux/macOS so devices that
    // don't announce themselves via the enumerator still show up.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let patterns: &[&str] = if cfg!(target_os = "linux") {
            &[
                "/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyUSB2", "/dev/ttyUSB3",
                "/dev/ttyACM0", "/dev/ttyACM1", "/dev/ttyACM2",
                "/dev/ttyS0", "/dev/ttyS1", "/dev/ttyS2",
                "/dev/ttyAMA0", "/dev/ttyAMA1", // Raspberry Pi UARTs
            ]
        } else {
            &[
                "/dev/cu.usbmodem0", "/dev/cu.usbserial-0",
                "/dev/cu.Bluetooth-Incoming-Port",
            ]
        };
        for p in patterns {
            if std::path::Path::new(p).exists() && !seen.contains(*p) {
                ports.push(crate::vault::SerialPortInfo {
                    port_name: p.to_string(),
                    description: None,
                });
            }
        }
    }

    // Windows fallback — note: on Windows the serialport crate already
    // enumerates COM ports via SetupAPI, so we don't need manual probing.

    // Sort: /dev/serial/by-id entries first (stable, descriptive), then
    // device nodes alphabetically.
    ports.sort_by(|a, b| {
        let ai = a.port_name.contains("by-id") || a.port_name.contains("by-path");
        let bi = b.port_name.contains("by-id") || b.port_name.contains("by-path");
        match (ai, bi) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.port_name.cmp(&b.port_name),
        }
    });

    ports
}

#[tauri::command(async)]
pub fn serial_open(
    req: SerialOpenRequest,
    on_event: tauri::ipc::Channel<PtyEvent>,
    mgr: State<'_, SerialManager>,
) -> AppResult<String> {
    // Build the serial-port builder with the requested parameters. The
    // serialport crate uses the "set_*" builder pattern.
    let port_builder = serialport::new(&req.port_name, req.baud_rate)
        .data_bits(parse_data_bits(req.data_bits)?)
        .stop_bits(parse_stop_bits(req.stop_bits)?)
        .parity(parse_parity(&req.parity))
        .flow_control(parse_flow_control(&req.flow_control))
        .timeout(Duration::from_millis(100));

    let mut port = port_builder
        .open()
        .map_err(|e| AppError::Other(format!("Failed to open {}: {}", req.port_name, e)))?;

    // Reset Arduino-like boards by pulsing DTR low briefly. This is the
    // conventional behavior that terminal programs (picocom, screen,
    // Arduino Serial Monitor) do; microcontroller users expect it.
    // Ignore errors — some USB-serial adapters and physical ports don't
    // support DTR.
    let _ = port.write_data_terminal_ready(false);
    thread::sleep(Duration::from_millis(50));
    let _ = port.write_data_terminal_ready(true);

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<Cmd>();

    mgr.sessions.lock().insert(
        session_id.clone(),
        SessionHandle { tx },
    );

    let banner = format!(
        "{} @ {} baud, {}/{}/{} ({})",
        req.port_name,
        req.baud_rate,
        req.data_bits,
        match req.parity.as_str() {
            "odd" => 'O', "even" => 'E', "mark" => 'M', "space" => 'S', _ => 'N',
        },
        req.stop_bits,
        match req.flow_control.as_str() {
            "software" => "XON/XOFF",
            "hardware" => "RTS/CTS",
            _ => "no flow control",
        },
    );

    let _ = on_event.send(PtyEvent::Connected {
        session_id: session_id.clone(),
        fingerprint: "serial".into(),
        banner: Some(banner.clone()),
        os: None,
    });

    // Emit the port path as the "cwd" so the terminal status bar shows
    // what we're connected to (we don't have a real cwd on a serial port).
    let _ = on_event.send(PtyEvent::Cwd {
        path: req.port_name.clone(),
    });

    let sid = session_id.clone();
    let event_ch = on_event.clone();
    let sessions = mgr.sessions.clone();
    thread::Builder::new()
        .name(format!("serial-{}", &sid[..8]))
        .spawn(move || {
            let reason = serial_io_loop(&mut *port, rx, &event_ch);
            let _ = event_ch.send(PtyEvent::Disconnected {
                reason,
                resumable: false,
            });
            sessions.lock().remove(&sid);
        })
        .map_err(|e| AppError::Io(e))?;

    // Let the user know we're connected via a small in-band banner the
    // same way the local shell does. We use a dim-gray ANSI style.
    let _ = on_event.send(PtyEvent::Output {
        b64: B64.encode(format!(
            "\r\n\x1b[90m→ Connected to {}\x1b[0m\r\n",
            banner
        )),
    });

    Ok(session_id)
}

fn serial_io_loop(
    port: &mut dyn SerialPort,
    rx: Receiver<Cmd>,
    events: &tauri::ipc::Channel<PtyEvent>,
) -> String {
    // The port is configured with a 100 ms read timeout so we can poll
    // for UI commands (writes / close) without blocking indefinitely on
    // read. We don't need nonblocking mode because the timeout gives us
    // adequate responsiveness.
    let mut buf = vec![0u8; 4096];

    loop {
        // 1. Drain pending UI commands.
        loop {
            match rx.try_recv() {
                Ok(Cmd::Write(bytes)) => {
                    if let Err(e) = port.write_all(&bytes) {
                        return format!("write failed: {e}");
                    }
                    let _ = port.flush();
                }
                Ok(Cmd::PulseDtr) => {
                    let _ = port.write_data_terminal_ready(false);
                    thread::sleep(Duration::from_millis(50));
                    let _ = port.write_data_terminal_ready(true);
                }
                Ok(Cmd::Close) | Err(mpsc::TryRecvError::Disconnected) => {
                    return "closed by user".to_string();
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }

        // 2. Read bytes from the serial device.
        match port.read(&mut buf) {
            Ok(0) => {
                // EOF — shouldn't normally happen for a serial port
                // (it stays open until explicitly closed). Treat as a
                // disconnect event.
                thread::sleep(Duration::from_millis(20));
            }
            Ok(n) => {
                if events
                    .send(PtyEvent::Output {
                        b64: B64.encode(&buf[..n]),
                    })
                    .is_err()
                {
                    // Frontend detached (window reload, tab closed).
                    return "frontend detached".to_string();
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                // No data available this tick; loop back to drain
                // commands.
            }
            Err(e) => {
                return format!("serial port error: {e}");
            }
        }
    }
}

#[tauri::command]
pub fn serial_write(session_id: String, data: String, mgr: State<'_, SerialManager>) -> AppResult<()> {
    mgr.send(&session_id, Cmd::Write(data.into_bytes()))
}

#[tauri::command]
pub fn serial_close(session_id: String, mgr: State<'_, SerialManager>) -> AppResult<()> {
    let _ = mgr.send(&session_id, Cmd::Close);
    Ok(())
}
