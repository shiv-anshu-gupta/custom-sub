//! FFI bindings to the C++ SV Subscriber native library
//!
//! Only functions actually called from Tauri commands are declared here.
//! C++ capture thread feeds packets via lock-free SPSC pipeline internally — no Rust binding needed.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

extern "C" {
    // --- sv_subscriber.cc ---
    fn sv_subscriber_init(sv_id: *const c_char, smp_cnt_max: u16);
    fn sv_subscriber_get_poll_json(start_index: u32, max_frames: u32) -> *const c_char;
    fn sv_subscriber_get_frame_detail_json(frame_index: u32) -> *const c_char;
    fn sv_subscriber_reset();
    fn sv_subscriber_set_phasor_mode(mode: u8);

    // --- sv_phasor_csv (dual-mode CSV logger) ---
    fn sv_subscriber_csv_start(filepath: *const c_char) -> i32;
    fn sv_subscriber_csv_stop();
    fn sv_subscriber_csv_status_json() -> *const c_char;

    // --- sv_capture_impl.cc ---
    fn sv_capture_load_dll() -> i32;
    pub fn sv_capture_dll_loaded() -> i32;
    fn sv_capture_list_interfaces_json() -> *const c_char;
    fn sv_capture_open(device_name: *const c_char) -> i32;
    fn sv_capture_close();
    fn sv_capture_start() -> i32;
    fn sv_capture_stop() -> i32;
    fn sv_capture_get_stats_json() -> *const c_char;
    fn sv_capture_get_error() -> *const c_char;
    fn sv_capture_get_timestamp_info_json() -> *const c_char;
}

// ============================================================================
// Safe Rust wrappers
// ============================================================================

/// Convert a C string pointer to a Rust String (copies data)
/// Returns empty string if pointer is null or invalid UTF-8
pub fn c_str_to_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .unwrap_or("")
        .to_owned()
}

/// Initialize the subscriber engine
pub fn init_subscriber(sv_id: &str, smp_cnt_max: u16) {
    let c_sv_id = CString::new(sv_id).unwrap_or_default();
    unsafe {
        sv_subscriber_init(c_sv_id.as_ptr(), smp_cnt_max);
    }
}

/// Load Npcap DLL
pub fn load_capture_dll() -> Result<(), String> {
    let rc = unsafe { sv_capture_load_dll() };
    if rc == 1 {
        Ok(())
    } else {
        let err = c_str_to_string(unsafe { sv_capture_get_error() });
        Err(format!("Failed to load Npcap DLL: {}", err))
    }
}

/// List network interfaces as JSON
pub fn list_interfaces_json() -> String {
    c_str_to_string(unsafe { sv_capture_list_interfaces_json() })
}

/// Open a capture interface
pub fn open_interface(device: &str) -> Result<(), String> {
    let c_device = CString::new(device).unwrap_or_default();
    let rc = unsafe { sv_capture_open(c_device.as_ptr()) };
    if rc == 0 {
        Ok(())
    } else {
        let err = c_str_to_string(unsafe { sv_capture_get_error() });
        Err(format!("Failed to open interface: {}", err))
    }
}

/// Start packet capture
pub fn start_capture() -> Result<(), String> {
    let rc = unsafe { sv_capture_start() };
    if rc == 0 {
        Ok(())
    } else {
        let err = c_str_to_string(unsafe { sv_capture_get_error() });
        Err(format!("Failed to start capture: {}", err))
    }
}

/// Stop packet capture
pub fn stop_capture() -> Result<(), String> {
    let rc = unsafe { sv_capture_stop() };
    if rc == 0 {
        Ok(())
    } else {
        Err("Failed to stop capture".to_string())
    }
}

/// Close capture interface
pub fn close_interface() {
    unsafe { sv_capture_close() };
}

/// Get capture stats JSON
pub fn get_capture_stats_json() -> String {
    c_str_to_string(unsafe { sv_capture_get_stats_json() })
}

/// Get timestamp configuration info JSON
pub fn get_timestamp_info_json() -> String {
    c_str_to_string(unsafe { sv_capture_get_timestamp_info_json() })
}

/// Get combined poll data (frames + analysis + status) in one call
pub fn get_poll_json(start_index: u32, max_frames: u32) -> String {
    c_str_to_string(unsafe { sv_subscriber_get_poll_json(start_index, max_frames) })
}

/// Get full detail for a single frame (on-demand, for frame viewer)
pub fn get_frame_detail_json(frame_index: u32) -> String {
    c_str_to_string(unsafe { sv_subscriber_get_frame_detail_json(frame_index) })
}

/// Reset subscriber
pub fn reset_subscriber() {
    unsafe { sv_subscriber_reset() };
}

/// Set phasor computation mode
/// mode: 0 = HALF_CYCLE (Task 1), 1 = FULL_CYCLE (Task 2)
pub fn set_phasor_mode(mode: u8) {
    unsafe { sv_subscriber_set_phasor_mode(mode) };
}

/// Start CSV phasor logging to file
pub fn csv_start(filepath: &str) -> Result<(), String> {
    let c_path = CString::new(filepath).unwrap_or_default();
    let rc = unsafe { sv_subscriber_csv_start(c_path.as_ptr()) };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!("Failed to open CSV file: {}", filepath))
    }
}

/// Stop CSV phasor logging
pub fn csv_stop() {
    unsafe { sv_subscriber_csv_stop() };
}

/// Get CSV logger status as JSON
pub fn csv_status_json() -> String {
    c_str_to_string(unsafe { sv_subscriber_csv_status_json() })
}
