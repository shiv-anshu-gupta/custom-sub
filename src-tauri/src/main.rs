//! SV Subscriber — Tauri Desktop Application
//!
//! Architecture:
//!   Frontend (HTML/JS) → Tauri invoke() → Rust commands → C++ FFI → JSON → JS
//!
//! All heavy processing (SV decoding, analysis, Npcap capture) runs in C++.
//! Rust is a thin bridge. JS only renders the UI.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sv_subscriber_app::run();
}
