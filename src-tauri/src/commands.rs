use std::collections::HashMap;
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::models::{AppConfig, FileEntry, ServerDef, SessionInfo};
use crate::ssh::SshSession;
use crate::store;

/// 全局会话表
pub struct AppState {
    pub sessions: Mutex<HashMap<String, Arc<SshSession>>>,
    pub config: Mutex<AppConfig>,
}

impl AppState {
    pub fn new(cfg: AppConfig) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            config: Mutex::new(cfg),
        }
    }
    pub fn get_session(&self, id: &str) -> AppResult<Arc<SshSession>> {
        self.sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::msg(format!("会话 {id} 不存在或已关闭")))
    }
}

/* ---------------- 配置存取 ---------------- */

#[tauri::command]
pub fn store_load(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().clone()
}

#[tauri::command]
pub fn store_save(app: AppHandle, state: State<'_, AppState>, config: AppConfig) -> AppResult<()> {
    *state.config.lock() = config.clone();
    store::save(&app, &config)
}

/// 清除某台主机的 known_hosts 记录。
///
/// 主机重装 / 确认换了密钥后使用；否则主机密钥校验会一直拒绝连接。
/// 返回删除的记录条数（0 表示本来就没有记录）。
#[tauri::command]
pub fn host_key_forget(app: AppHandle, host: String, port: u16) -> AppResult<usize> {
    let path = crate::ssh::known_hosts::path(&app);
    let port = if port == 0 { 22 } else { port };
    crate::ssh::known_hosts::forget(&path, host.trim(), port)
        .map_err(|e| AppError::msg(format!("清理主机密钥失败：{e}")))
}

#[tauri::command]
pub fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "LinkConsole",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "ssh": "russh 0.63 (ring)",
    })
}

/* ---------------- SSH 会话 ---------------- */

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    server: ServerDef,
    cols: u32,
    rows: u32,
) -> AppResult<SessionInfo> {
    let (server, proxies) = {
        let cfg = state.config.lock().clone();
        let mut s = server;
        // 以配置中的持久化数据补全（前端只传 id 时尤其重要）。
        // id 为空绝不能匹配：`x.id == s.id` 会把 id 为空的脏记录当成同一条主机，
        // 用户刚在表单里填的 IP / 密码会被静默替换成那条记录的值。
        if !s.id.is_empty() {
            if let Some(stored) = cfg.servers.iter().find(|x| x.id == s.id) {
                s = stored.clone();
            }
        }
        (s, cfg.proxies.clone())
    };

    let sess = crate::ssh::connect(app.clone(), &server, &proxies, cols.max(20), rows.max(8)).await?;
    // 会话已在 connect 内部登记（保证「读取任务结束」一定发生在登记之后），这里只回传信息
    Ok(sess.info())
}

#[tauri::command]
pub async fn ssh_write(state: State<'_, AppState>, session_id: String, data: String) -> AppResult<()> {
    state.get_session(&session_id)?.send_text(&data).await
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    state.get_session(&session_id)?.resize(cols.max(2), rows.max(2)).await
}

#[tauri::command]
pub async fn ssh_close(app: AppHandle, state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let sess = state.sessions.lock().remove(&session_id);
    if let Some(s) = sess {
        s.close().await;
    }
    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn session_cwd(state: State<'_, AppState>, session_id: String) -> String {
    state
        .get_session(&session_id)
        .map(|s| s.cwd.lock().clone())
        .unwrap_or_default()
}

/// 实时校正远端工作目录：在独立 exec 通道执行 `pwd`（不污染终端输出）。
/// 前端仅在「提示符与本地记录不一致」或「疑似缺分隔符」时调用，带防抖限频。
#[tauri::command]
pub async fn probe_cwd(state: State<'_, AppState>, session_id: String) -> AppResult<String> {
    let sess = state.get_session(&session_id)?;
    let out = crate::ssh::exec_capture(&sess.handle, "pwd").await?;
    let cwd = out.trim().to_string();
    if !cwd.starts_with('/') {
        return Err(crate::error::AppError::msg("pwd 返回值非法"));
    }
    *sess.cwd.lock() = cwd.clone();
    Ok(cwd)
}

/// 在独立 exec 通道执行一条命令并返回输出（不污染终端）。
/// 用于重连后的环境探测（tmux / screen 会话列表）等内部用途。
#[tauri::command]
pub async fn ssh_exec_quiet(state: State<'_, AppState>, session_id: String, cmd: String) -> AppResult<String> {
    let sess = state.get_session(&session_id)?;
    crate::ssh::exec_capture(&sess.handle, &cmd).await
}

/// 连通性测试：验证 TCP / 代理 / 跳板机可达（不做 SSH 握手）
///
/// `proxy` 允许直接传入表单里尚未保存的代理定义——新建代理时点「测试连接」
/// 不应该依赖它已经落库（早前只传 proxy_id，后端查不到记录就退化成直连，
/// 表现为「测试必超时、且每点一次就多出一个代理」）。
#[tauri::command]
pub async fn net_probe(
    app: AppHandle,
    state: State<'_, AppState>,
    target: String,
    proxy_id: Option<String>,
    proxy: Option<crate::models::ProxyDef>,
) -> AppResult<String> {
    let resolved = match proxy {
        Some(p) => Some(p),
        None => {
            let id = proxy_id.unwrap_or_default();
            if id.is_empty() {
                None
            } else {
                state.config.lock().proxies.iter().find(|p| p.id == id).cloned()
            }
        }
    };
    let kh = crate::ssh::known_hosts::path(&app);
    crate::net::proxy::probe(&target, resolved.as_ref(), &kh).await
}

/* ---------------- 代理测试 ---------------- */

/// 代理服务器「测试连接」：验证代理 / 跳板机自身是否可用，不需要测试目标。
#[tauri::command]
pub async fn net_probe_proxy(
    app: AppHandle,
    proxy: crate::models::ProxyDef,
) -> AppResult<crate::net::proxy::ProbeReport> {
    let kh = crate::ssh::known_hosts::path(&app);
    crate::net::proxy::probe_proxy(&proxy, &kh).await
}

/* ---------------- SFTP ---------------- */

#[tauri::command]
pub async fn sftp_list(state: State<'_, AppState>, session_id: String, path: String) -> AppResult<Vec<FileEntry>> {
    let sess = state.get_session(&session_id)?;
    crate::sftp::list(&sess, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, AppState>, session_id: String, path: String) -> AppResult<()> {
    let sess = state.get_session(&session_id)?;
    crate::sftp::mkdir(&sess, &path).await
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> AppResult<()> {
    let sess = state.get_session(&session_id)?;
    crate::sftp::remove(&sess, &path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let sess = state.get_session(&session_id)?;
    crate::sftp::rename(&sess, &from, &to).await
}

/// 启动一次上传（后台执行，立即返回；进度 / 结果通过 `sftp-progress` 事件推送）
#[tauri::command]
pub async fn sftp_start_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_dir: String,
    transfer_id: String,
) -> AppResult<()> {
    let sess = state.get_session(&session_id)?;
    crate::sftp::spawn_upload(app, sess, local_path, remote_dir, transfer_id);
    Ok(())
}

/// 启动一次下载（后台执行，立即返回）
#[tauri::command]
pub async fn sftp_start_download(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> AppResult<()> {
    let sess = state.get_session(&session_id)?;
    crate::sftp::spawn_download(app, sess, remote_path, local_path, transfer_id);
    Ok(())
}

#[tauri::command]
pub fn sftp_pause_transfer(transfer_id: String) -> bool {
    crate::sftp::pause(&transfer_id)
}

#[tauri::command]
pub fn sftp_resume_transfer(transfer_id: String) -> bool {
    crate::sftp::resume(&transfer_id)
}

#[tauri::command]
pub fn sftp_cancel_transfer(transfer_id: String) -> bool {
    crate::sftp::cancel(&transfer_id)
}

/// 打开本地文件所在目录（下载完成后使用）
#[tauri::command]
pub async fn reveal_local(path: String) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    let target = if p.is_dir() { p.clone() } else { p.parent().map(|x| x.to_path_buf()).unwrap_or(p) };
    if !target.exists() {
        return Err(AppError::msg(format!("路径不存在: {}", target.display())));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(target).spawn().ok();
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(target).spawn().ok();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(target).spawn().ok();
    }
    Ok(())
}

/// 用户主目录（下载默认位置）
static HOME: Lazy<Option<String>> = Lazy::new(|| std::env::var("USERPROFILE").ok());

#[tauri::command]
pub fn default_download_dir() -> String {
    HOME.clone()
        .map(|h| format!("{h}\\Downloads"))
        .unwrap_or_else(|| ".".into())
}

#[tauri::command]
pub fn sessions_of(state: State<'_, AppState>, server_id: String) -> Vec<SessionInfo> {
    state
        .sessions
        .lock()
        .values()
        .filter(|s| s.info.server_id == server_id)
        .map(|s| s.info())
        .collect()
}
