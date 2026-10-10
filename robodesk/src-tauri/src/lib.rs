//! Tauri shell. All data logic lives in `robodesk-core`; this file only exposes it to the
//! webview (one `api` command) plus the few things that need the operating system:
//! native file dialogs and opening files/links with their default application.

use robodesk_core::error::ApiError;
use robodesk_core::Core;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn err(code: &'static str, message: impl Into<String>) -> ApiError {
    ApiError { code, message: message.into(), field: None }
}

/// Single entry point for data operations: `invoke('api', { cmd, args })`.
#[tauri::command]
async fn api(core: State<'_, Core>, cmd: String, args: Option<Value>) -> Result<Value, ApiError> {
    core.dispatch(&cmd, args.unwrap_or(Value::Null))
}

fn filters(kind: &str) -> Option<(&'static str, &'static [&'static str])> {
    match kind {
        "cad" => Some(("Fusion 360 files", &["f3d", "f3z"])),
        "csv" => Some(("CSV", &["csv"])),
        "json" => Some(("RoboDesk export", &["json"])),
        _ => None,
    }
}

/// Native "open files" dialog. `kind` is one of: cad, json. Returns absolute paths (empty if cancelled).
#[tauri::command]
async fn pick_files(app: AppHandle, kind: String, multiple: bool) -> Result<Vec<String>, ApiError> {
    let (label, exts) = filters(&kind).ok_or_else(|| err("validation", "Unknown file type."))?;
    let dlg = app.dialog().file().add_filter(label, exts);
    let picked = if multiple { dlg.blocking_pick_files().unwrap_or_default() } else { dlg.blocking_pick_file().into_iter().collect() };
    Ok(picked.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()).collect())
}

/// Native "save as" dialog. Returns the chosen absolute path, or null if cancelled.
#[tauri::command]
async fn pick_save_path(app: AppHandle, kind: String, default_name: String) -> Result<Option<String>, ApiError> {
    let (label, exts) = filters(&kind).ok_or_else(|| err("validation", "Unknown file type."))?;
    let picked = app.dialog().file().add_filter(label, exts).set_file_name(default_name).blocking_save_file();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| {
        let mut s = p.to_string_lossy().to_string();
        // Make sure the extension matches the chosen type even if the user typed a bare name.
        if !exts.iter().any(|e| s.to_lowercase().ends_with(&format!(".{e}"))) {
            s.push('.');
            s.push_str(exts[0]);
        }
        s
    }))
}

/// Native folder picker. Returns null if cancelled.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, ApiError> {
    Ok(app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
}

/// Open a registered CAD file with its associated application (e.g. Fusion 360).
/// The core only resolves entries that are registered, exist, and are .f3d/.f3z files.
#[tauri::command]
async fn open_cad(app: AppHandle, core: State<'_, Core>, id: i64) -> Result<(), ApiError> {
    let path = core.call("cad.resolve_open", json!({ "id": id })).map_err(ApiError::from)?;
    let path = path.as_str().unwrap_or_default().to_string();
    app.opener().open_path(path, None::<&str>).map_err(|e| err("io", format!("Could not open the file: {e}")))
}

/// Show a registered CAD file in Windows Explorer.
#[tauri::command]
async fn reveal_cad(app: AppHandle, core: State<'_, Core>, id: i64) -> Result<(), ApiError> {
    let path = core.call("cad.resolve_open", json!({ "id": id })).map_err(ApiError::from)?;
    let path = path.as_str().unwrap_or_default().to_string();
    app.opener().reveal_item_in_dir(path).map_err(|e| err("io", format!("Could not show the file: {e}")))
}

/// Open a part's datasheet link in the default browser (http/https only).
#[tauri::command]
async fn open_datasheet(app: AppHandle, core: State<'_, Core>, id: i64) -> Result<(), ApiError> {
    let url = core.call("components.open_datasheet", json!({ "id": id })).map_err(ApiError::from)?;
    let url = robodesk_core::checked_url(url.as_str().unwrap_or_default()).map_err(ApiError::from)?;
    app.opener().open_url(url, None::<&str>).map_err(|e| err("io", format!("Could not open the link: {e}")))
}

/// Open the folder that holds the database and backups.
#[tauri::command]
async fn reveal_data_folder(app: AppHandle, core: State<'_, Core>) -> Result<(), ApiError> {
    let info = core.call("app.info", Value::Null).map_err(ApiError::from)?;
    let dir = info["data_dir"].as_str().unwrap_or_default().to_string();
    app.opener().open_path(dir, None::<&str>).map_err(|e| err("io", format!("Could not open the folder: {e}")))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let core = Core::open(config_dir, data_dir).map_err(|e| format!("RoboDesk could not open its database: {e}"))?;
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api, pick_files, pick_save_path, pick_folder, open_cad, reveal_cad, open_datasheet, reveal_data_folder])
        .run(tauri::generate_context!())
        .expect("error while running RoboDesk");
}
