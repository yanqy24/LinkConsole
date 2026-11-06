mod commands;
mod desktop;
mod error;
mod logging;
mod menu;
mod models;
mod net;
mod sftp;
mod ssh;
mod store;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 自定义标题栏：decorum 负责 Win11 贴靠布局（Snap Layouts）等原生窗口行为，
        // 标题栏与三个按钮仍由前端自绘，保持与界面一致的视觉。
        .plugin(tauri_plugin_decorum::init())
        // 原生菜单点击：菜单项 id 由前端在弹出时分配，这里原样回传。
        .on_menu_event(|app, event| {
            let _ = app.emit("native-menu", event.id().0.clone());
        })
        .setup(|app| {
            let cfg = store::load(app.handle());
            let material = cfg
                .settings
                .get("material")
                .and_then(|v| v.as_str())
                .unwrap_or("auto")
                .to_string();
            app.manage(commands::AppState::new(cfg));

            if let Some(win) = app.get_webview_window("main") {
                desktop::init_window(win);
            }

            log::info!("LinkConsole 已启动（材质：{material}）");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::store_load,
            commands::store_save,
            commands::host_key_forget,
            commands::app_info,
            commands::ssh_connect,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_close,
            commands::session_cwd,
            commands::probe_cwd,
            commands::ssh_exec_quiet,
            commands::net_probe,
            commands::net_probe_proxy,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_start_upload,
            commands::sftp_start_download,
            commands::sftp_pause_transfer,
            commands::sftp_resume_transfer,
            commands::sftp_cancel_transfer,
            commands::reveal_local,
            commands::default_download_dir,
            commands::sessions_of,
            menu::popup_menu,
            desktop::set_window_material,
            logging::log_path_command,
        ])
        .run(tauri::generate_context!())
        .expect("LinkConsole 启动失败");
}
