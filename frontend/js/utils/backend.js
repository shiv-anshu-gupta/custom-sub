/**
 * @file utils/backend.js
 * @brief Tauri IPC wrapper for C++ backend communication
 *
 * Single utility for all backend calls:
 *   JS → Tauri invoke() → Rust #[tauri::command] → C++ extern "C" → JSON → JS
 */

const { invoke } = window.__TAURI__.core;

/**
 * Call C++ backend via Tauri Rust bridge
 * @param {string} cmd   Tauri command name (maps to #[tauri::command])
 * @param {object} args  Arguments object
 * @returns {Promise<any>} Parsed result from backend
 */
async function backendCall(cmd, args = {}) {
    try {
        return await invoke(cmd, args);
    } catch (err) {
        console.error(`[backend] ${cmd} failed:`, err);
        throw err;
    }
}
