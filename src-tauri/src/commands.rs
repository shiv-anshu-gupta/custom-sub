//! Tauri commands — the bridge between JavaScript frontend and C++ backend
//!
//! Each #[tauri::command] function is callable from JS via:
//!   await window.__TAURI__.core.invoke('command_name', { args })
//!
//! Data flow:
//!   JS invoke() → Rust command → FFI call → C++ function → JSON string → JS
//!
//! All heavy processing (decoding, analysis, capture) runs in C++.
//! Rust only marshals data between JS and C++.

use crate::db;
use crate::ffi;
use serde_json::Value;

// ============================================================================
// Subscriber Commands
// ============================================================================

/// Initialize the SV subscriber engine
/// Called once when user clicks "Capture"
#[tauri::command]
pub fn init_subscriber(sv_id: String, smp_cnt_max: u16) -> Result<Value, String> {
    // Load Npcap DLL if not already loaded
    if unsafe { ffi::sv_capture_dll_loaded() } == 0 {
        ffi::load_capture_dll()?;
    }

    // Use 65535 as sentinel for auto-detect mode in C++
    let max_val = if smp_cnt_max == 0 { 65535 } else { smp_cnt_max };
    ffi::init_subscriber(&sv_id, max_val);
    Ok(serde_json::json!({ "ok": true }))
}

/// Combined poll — returns frames + analysis + status in ONE call.
///
/// Fast path (recording OFF, which is >99% of the time):
///   Three C++ JSON strings are merged by string slicing — completely avoiding
///   a parse → Value → re-serialize round trip of the potentially 4 MB payload.
///
/// Recording path (recording ON):
///   Parse the merged JSON once to extract frames for SQLite, same cost
///   as before.  is_recording() is an atomic bool load, so the check is free.
#[tauri::command]
pub fn poll_data(start_index: u32, max_frames: u32) -> Result<Box<serde_json::value::RawValue>, String> {
    let poll_json = ffi::get_poll_json(start_index, max_frames);
    let cap_json  = ffi::get_capture_stats_json();
    let ts_json   = ffi::get_timestamp_info_json();

    // Merge the three JSON objects by string manipulation.
    // poll_json is a complete JSON object ending with '}'.
    // Strip that final '}' and append the two extra fields.
    let merged = {
        let base = poll_json.trim_end_matches(|c: char| c.is_whitespace());
        if base.ends_with('}') {
            format!(r#"{},"captureStats":{},"timestampInfo":{}}}"#,
                &base[..base.len() - 1], cap_json, ts_json)
        } else {
            // Malformed poll_json — pass through and let RawValue catch it
            poll_json.clone()
        }
    };

    // SQLite recording path — only parse when recording is active (rare case).
    // is_recording() is an atomic bool load (~1 CPU cycle).
    if db::is_recording() {
        if let Ok(parsed) = serde_json::from_str::<Value>(&merged) {
            if let Some(frames) = parsed["frames"].as_array() {
                if !frames.is_empty() {
                    db::store_poll_frames(frames);
                }
            }
        }
    }

    serde_json::value::RawValue::from_string(merged)
        .map_err(|e| format!("Poll JSON invalid: {}", e))
}

/// Reset all subscriber state — clears ring buffer and analysis counters
#[tauri::command]
pub fn reset() -> Result<Value, String> {
    ffi::reset_subscriber();
    Ok(serde_json::json!({ "ok": true }))
}

/// Set phasor computation mode
/// mode: 0 = HALF_CYCLE (Task 1: ½ cycle DFT), 1 = FULL_CYCLE (Task 2: 1 cycle DFT)
#[tauri::command]
pub fn set_phasor_mode(mode: u8) -> Result<Value, String> {
    if mode > 1 {
        return Err("Invalid phasor mode (0=half, 1=full)".to_string());
    }
    ffi::set_phasor_mode(mode);
    Ok(serde_json::json!({ "ok": true, "mode": mode }))
}

// ============================================================================
// CSV Phasor Logger Commands — Dual-mode (half + full cycle) CSV output
// ============================================================================

/// Start CSV phasor logging to a file
/// filepath: Absolute path for the CSV output (e.g., "C:/data/phasors.csv")
#[tauri::command]
pub fn csv_start(filepath: String) -> Result<Value, String> {
    ffi::csv_start(&filepath)?;
    Ok(serde_json::json!({ "ok": true, "filepath": filepath }))
}

/// Stop CSV phasor logging (flush + close file)
#[tauri::command]
pub fn csv_stop() -> Result<Value, String> {
    ffi::csv_stop();
    Ok(serde_json::json!({ "ok": true }))
}

/// Get CSV logger status (logging state, row count, timing stats per mode)
#[tauri::command]
pub fn csv_status() -> Result<Value, String> {
    let json_str = ffi::csv_status_json();
    serde_json::from_str(&json_str).map_err(|e| format!("CSV status JSON parse error: {}", e))
}

/// Get full detail for a single frame (on-demand, for frame structure viewer)
/// Only called when user clicks a table row — NOT part of the polling loop
#[tauri::command]
pub fn get_frame_detail(frame_index: u32) -> Result<Value, String> {
    let json_str = ffi::get_frame_detail_json(frame_index);
    serde_json::from_str(&json_str).map_err(|e| format!("Frame detail JSON parse error: {}", e))
}

// ============================================================================
// Capture Commands — Npcap interface management
// ============================================================================

/// List available network interfaces
/// Returns JSON with interface names, descriptions, MACs
#[tauri::command]
pub fn list_interfaces() -> Result<Value, String> {
    // Ensure DLL is loaded
    if unsafe { ffi::sv_capture_dll_loaded() } == 0 {
        ffi::load_capture_dll()?;
    }

    let json_str = ffi::list_interfaces_json();
    serde_json::from_str(&json_str).map_err(|e| format!("JSON parse error: {}", e))
}

/// Open a network interface for SV capture
#[tauri::command]
pub fn capture_open(device: String) -> Result<Value, String> {
    ffi::open_interface(&device)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Start the capture thread (packets flow: NIC → decoder → ring buffer)
#[tauri::command]
pub fn capture_start() -> Result<Value, String> {
    ffi::start_capture()?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Stop the capture thread
#[tauri::command]
pub fn capture_stop() -> Result<Value, String> {
    ffi::stop_capture()?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Close the capture interface
#[tauri::command]
pub fn capture_close() -> Result<Value, String> {
    ffi::close_interface();
    Ok(serde_json::json!({ "ok": true }))
}

/// Get capture statistics (packets received, dropped, rate)
#[tauri::command]
pub fn get_capture_stats() -> Result<Value, String> {
    let json_str = ffi::get_capture_stats_json();
    serde_json::from_str(&json_str).map_err(|e| format!("JSON parse error: {}", e))
}

/// Get timestamp configuration info (type, precision, hardware/software)
#[tauri::command]
pub fn get_timestamp_info() -> Result<Value, String> {
    let json_str = ffi::get_timestamp_info_json();
    serde_json::from_str(&json_str).map_err(|e| format!("JSON parse error: {}", e))
}

// ============================================================================
// Database Commands — SQLite session recording and history
// ============================================================================

/// Start a new SQLite recording session.
/// Called by frontend when capture begins. Creates a session row and enables
/// frame recording in poll_data.
#[tauri::command]
pub fn db_start_session(config: db::SessionConfig) -> Result<Value, String> {
    let session_id = db::start_session(config)?;
    Ok(serde_json::json!({ "sessionId": session_id }))
}

/// End the active recording session.
/// Flushes pending frames, updates session with summary stats, disables recording.
#[tauri::command]
pub fn db_end_session(session_id: i64, summary: db::SessionSummary) -> Result<Value, String> {
    db::end_session(session_id, summary)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// List all capture sessions (newest first)
#[tauri::command]
pub fn db_list_sessions() -> Result<Value, String> {
    db::list_sessions()
}

/// Get frames for a specific session (paginated)
#[tauri::command]
pub fn db_get_session_frames(
    session_id: i64,
    limit: u32,
    offset: u32,
) -> Result<Value, String> {
    db::get_session_frames(session_id, limit, offset)
}

/// Delete a session and all its stored frames
#[tauri::command]
pub fn db_delete_session(session_id: i64) -> Result<Value, String> {
    db::delete_session(session_id)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Get database info (path, size, counts)
#[tauri::command]
pub fn db_get_info() -> Result<Value, String> {
    db::get_db_info()
}

/// Export a session as a PCAP file.
/// Reconstructs IEC 61850-9-2LE packets from stored decoded data.
/// If output_path is empty, saves next to the database file.
/// Returns the absolute path of the exported file.
#[tauri::command]
pub fn db_export_pcap(session_id: i64, output_path: String) -> Result<Value, String> {
    let path = db::export_pcap(session_id, &output_path)?;
    Ok(serde_json::json!({ "path": path }))
}
