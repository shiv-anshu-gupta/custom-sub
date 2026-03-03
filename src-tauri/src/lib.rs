//! Library entry point for Tauri
//! Contains the main run() function that sets up the Tauri application.

mod commands;
mod db;
mod ffi;

/// Run the Tauri application
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Initialize SQLite database in the app data directory.
            // Non-fatal: if DB init fails, capture still works (just no recording).
            use tauri::Manager;
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| {
                // Fallback: %APPDATA%/SV-Subscriber on Windows, ./data otherwise
                std::env::var("APPDATA")
                    .map(|p| std::path::PathBuf::from(p).join("SV-Subscriber"))
                    .unwrap_or_else(|_| std::path::PathBuf::from("./data"))
            });
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("sv_data.db");

            match db::initialize(db_path) {
                Ok(_) => println!("[app] SQLite database ready"),
                Err(e) => eprintln!("[app] Warning: SQLite init failed: {} — recording disabled", e),
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Subscriber commands
            commands::init_subscriber,
            commands::poll_data,
            commands::reset,
            commands::get_frame_detail,
            commands::set_phasor_mode,
            // CSV phasor logger commands
            commands::csv_start,
            commands::csv_stop,
            commands::csv_status,
            // Capture commands
            commands::list_interfaces,
            commands::capture_open,
            commands::capture_start,
            commands::capture_stop,
            commands::capture_close,
            commands::get_capture_stats,
            commands::get_timestamp_info,
            // Database commands
            commands::db_start_session,
            commands::db_end_session,
            commands::db_list_sessions,
            commands::db_get_session_frames,
            commands::db_delete_session,
            commands::db_get_info,
            commands::db_export_pcap,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SV Subscriber application");
}
