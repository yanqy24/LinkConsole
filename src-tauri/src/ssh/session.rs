use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use russh::client::{self, Handle, Msg};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::models::{ProxyDef, ServerDef, SessionInfo};
use crate::ssh::known_hosts::{self, Verdict};

/// SSH 主机密钥校验（TOFU）。
///
/// 每个连接（含跳板机）都持有一份 `known_hosts` 路径与目标地址；
/// `check_server_key` 首次记录、之后比对，密钥变化即拒绝握手。
pub struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    /// 拒绝原因：`check_server_key` 只能返回 bool，具体原因放在这里由 connect 侧取出，
    /// 否则用户只会看到 russh 的 `UnknownKey`。
    reject: Arc<parking_lot::Mutex<Option<String>>>,
}

impl ClientHandler {
    pub fn new(host: impl Into<String>, port: u16, known_hosts: PathBuf) -> Self {
        Self {
            host: host.into(),
            port,
            known_hosts,
            reject: Arc::new(parking_lot::Mutex::new(None)),
        }
    }

    /// 拒绝原因的共享槽（必须在把 handler 交给 russh 之前取出）
    pub fn reject_slot(&self) -> Arc<parking_lot::Mutex<Option<String>>> {
        self.reject.clone()
    }

    // 校验失败的可读文案集中在这里，跳板机与目标机共用
    fn mismatch_message(&self, line: usize, old: &str, new: &str) -> String {
        format!(
            "主机密钥校验失败：{}:{} 的服务器密钥与本地记录不一致（known_hosts 第 {} 行）。\n\
             本地记录：{}\n本次提供：{}\n\
             这可能是中间人攻击，也可能是服务器重装 / 更换了密钥。\n\
             确认无误后，可在该主机右键菜单选择「重置主机密钥」再重新连接。",
            self.host, self.port, line, old, new
        )
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        match known_hosts::verify(&self.known_hosts, &self.host, self.port, &key) {
            Verdict::Known => Ok(true),
            Verdict::Learned(fp) => {
                log::warn!(
                    "首次连接 {}:{}，已记录主机密钥 {}（TOFU）",
                    self.host,
                    self.port,
                    fp
                );
                Ok(true)
            }
            Verdict::Changed { line, old, new } => {
                let msg = self.mismatch_message(line, &old, &new);
                log::error!("{msg}");
                *self.reject.lock() = Some(msg);
                Ok(false)
            }
        }
    }
}

/// 一个已连接的 SSH 会话（PTY）
pub struct SshSession {
    #[allow(dead_code)]
    pub id: String,
    pub info: SessionInfo,
    /// 用于打开新通道（SFTP 等）；其 `data`/`disconnect` 均为 `&self`
    pub handle: Arc<Handle<ClientHandler>>,
    /// PTY 写半部：键盘输入 / resize / 信号
    pub write: Arc<ChannelWriteHalf<Msg>>,
    pub cols: AtomicU32,
    pub rows: AtomicU32,
    pub cwd: parking_lot::Mutex<String>,
    pub closed: AtomicBool,
    /// 经跳板机连接时保活跳板机会话（None = 直连或常规代理）
    #[allow(dead_code)]
    pub jump: Option<crate::net::proxy::JumpKeep>,
}

impl SshSession {
    pub fn info(&self) -> SessionInfo {
        self.info.clone()
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed) || self.handle.is_closed()
    }
    pub async fn send_text(&self, data: &str) -> AppResult<()> {
        self.write
            .data_bytes(Bytes::from(data.to_owned()))
            .await
            .map_err(|_| AppError::msg("会话已关闭，数据未能发送"))
    }
    pub async fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        self.cols.store(cols, Ordering::Relaxed);
        self.rows.store(rows, Ordering::Relaxed);
        self.write
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| AppError::msg(format!("调整窗口大小失败: {e:?}")))
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        let _ = self.write.close().await;
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "bye", "en").await;
    }
}

/// 事件载荷
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEvent {
    pub id: String,
    pub data: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedEvent {
    pub id: String,
    pub reason: String,
}

pub fn ssh_config() -> Arc<client::Config> {
    let mut cfg = client::Config::default();
    cfg.keepalive_interval = Some(Duration::from_secs(15));
    cfg.keepalive_max = 4;
    cfg.inactivity_timeout = None;
    cfg.nodelay = true;
    Arc::new(cfg)
}

/// 建立连接并打开交互式 PTY
pub async fn connect(
    app: AppHandle,
    server: &ServerDef,
    proxies: &[ProxyDef],
    cols: u32,
    rows: u32,
) -> AppResult<Arc<SshSession>> {
    let proxy = server.proxy_label(proxies);
    // 主机密钥信任库：目标机与跳板机共用同一份文件
    let kh_path = crate::ssh::known_hosts::path(&app);
    // jump 类型：stream 是跳板机上的 direct-tcpip 通道，jump 会话需全程保活
    let (stream, jump) = crate::net::proxy::dial(&server.ip, server.port, proxy, &kh_path).await?;

    // 握手超时：端口 TCP 通但不回 SSH 协议（被中间设备接管、只放行 SYN 等）
    // 时 connect_stream 会永久挂起，界面就会一直停在「连接中…」。
    let handler = ClientHandler::new(server.ip.clone(), server.port, kh_path);
    let reject = handler.reject_slot();
    let handshake = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect_stream(ssh_config(), stream, handler),
    )
    .await
    .map_err(|_| {
        AppError::msg(
            "SSH 握手超时（15s）：目标端口有响应，但未按 SSH 协议应答（端口可能不是 SSH，或被中间设备拦截）",
        )
    })?;
    let mut handle: Handle<ClientHandler> = match handshake {
        Ok(h) => h,
        // 主机密钥不匹配时 russh 只返回 UnknownKey，这里换成用户能读懂、能处理的原因
        Err(e) => match reject.lock().take() {
            Some(msg) => return Err(AppError::msg(msg)),
            None => return Err(AppError::msg(format!("SSH 握手失败：{e}"))),
        },
    };

    // ---- 认证 ----
    // 私钥读取是本地同步操作，放在超时之外，避免把「私钥文件错误」误报成超时
    let key = match server.auth.as_str() {
        "key" => {
            let pwd = if server.password.is_empty() {
                None
            } else {
                Some(server.password.as_str())
            };
            Some(
                russh::keys::load_secret_key(&server.key_path, pwd)
                    .map_err(|e| AppError::msg(format!("读取私钥失败: {e:?}")))?,
            )
        }
        _ => None,
    };
    let authed = tokio::time::timeout(Duration::from_secs(20), async {
        match key {
            Some(key) => {
                let hash: Option<Option<HashAlg>> = handle.best_supported_rsa_hash().await?;
                let kph = PrivateKeyWithHashAlg::new(Arc::new(key), hash.flatten());
                handle.authenticate_publickey(&server.user, kph).await
            }
            None => {
                handle
                    .authenticate_password(&server.user, &server.password)
                    .await
            }
        }
    })
    .await
    .map_err(|_| AppError::msg("认证超时（20s）：服务器未在 20 秒内完成身份验证"))??;
    if !authed.success() {
        let _ = handle.disconnect(russh::Disconnect::AuthCancelledByUser, "auth failed", "en").await;
        return Err(AppError::msg(format!(
            "认证失败：用户 `{}` 的凭据被服务器拒绝",
            server.user
        )));
    }

    // ---- PTY + shell ----
    let channel = tokio::time::timeout(Duration::from_secs(15), async {
        let channel = handle.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| AppError::msg(format!("申请 PTY 失败（服务器可能不支持交互式终端）: {e:?}")))?;
        channel.request_shell(false).await?;
        Ok::<_, AppError>(channel)
    })
    .await
    .map_err(|_| AppError::msg("打开远程终端超时（15s）：服务器未响应 PTY / shell 请求"))??;
    let (read_half, write_half) = channel.split();

    let sid = format!("s-{}", next_id());
    let info = SessionInfo {
        id: sid.clone(),
        server_id: server.id.clone(),
        name: server.name.clone(),
        ip: server.ip.clone(),
        user: server.user.clone(),
        port: server.port,
        cols,
        rows,
    };

    let sess = Arc::new(SshSession {
        id: sid.clone(),
        info,
        handle: Arc::new(handle),
        write: Arc::new(write_half),
        cols: AtomicU32::new(cols),
        rows: AtomicU32::new(rows),
        cwd: parking_lot::Mutex::new("/".into()),
        closed: AtomicBool::new(false),
        jump,
    });

    // ---- 初始目录（独立 exec 通道，不污染终端输出）----
    let init_handle = sess.handle.clone();
    let init_sid = sid.clone();
    let init_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(cwd) = exec_capture(&init_handle, "pwd").await {
            let cwd = cwd.trim().to_string();
            if cwd.starts_with('/') {
                let _ = init_app.emit("ssh-cwd", DataEvent { id: init_sid, data: cwd });
            }
        }
    });

    // ---- 输出读取任务 ----
    // 先把会话登记进会话表，再启动读取任务：pump_output 结束时会把条目摘掉，
    // 如果登记晚于它（对端秒断）就会出现「移除空操作 + 事后又插入」的泄漏。
    if let Some(st) = app.try_state::<crate::commands::AppState>() {
        st.sessions.lock().insert(sid.clone(), sess.clone());
    } else {
        log::error!("会话表不可用，session {sid} 未能登记");
    }

    let rd_sid = sid.clone();
    let rd_app = app.clone();
    tauri::async_runtime::spawn(async move {
        pump_output(rd_app, rd_sid, read_half).await;
    });

    Ok(sess)
}

/// 单行命令捕获（用于 pwd 等内部探测）
pub async fn exec_capture(handle: &Handle<ClientHandler>, cmd: &str) -> AppResult<String> {
    // 必须带超时：链路半死（NAT 超时、跳板机卡住）时这个 future 会一直挂着，
    // 而调用方是 fire-and-forget 的 spawn，任务与通道就此泄漏。
    tokio::time::timeout(Duration::from_secs(8), exec_capture_inner(handle, cmd))
        .await
        .map_err(|_| AppError::msg("远程命令超时（8s）：链路无响应"))?
}

async fn exec_capture_inner(handle: &Handle<ClientHandler>, cmd: &str) -> AppResult<String> {
    let mut ch = handle.channel_open_session().await?;
    ch.exec(true, cmd).await?;
    let mut out: Vec<u8> = Vec::new();
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => out.extend_from_slice(&data),
            ChannelMsg::ExitStatus { .. } => {}
            ChannelMsg::Close | ChannelMsg::Eof => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// 读取 PTY 输出：增量 UTF-8 解码 + 合帧（16ms / 32KB）后经事件推送到前端
#[allow(unused_assignments)]
async fn pump_output(app: AppHandle, id: String, mut rh: ChannelReadHalf) {
    let mut pending: Vec<u8> = Vec::new();
    let mut closed_reason = String::new();

    loop {
        let flush_at = tokio::time::Instant::now() + Duration::from_millis(16);
        let msg = tokio::select! {
            m = rh.wait() => m,
            _ = tokio::time::sleep_until(flush_at) => {
                if !pending.is_empty() {
                    let data = decode_incremental(&mut pending);
                    let _ = app.emit("ssh-data", DataEvent { id: id.clone(), data });
                }
                continue;
            }
        };

        match msg {
            Some(ChannelMsg::Data { data }) => pending.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, .. }) => pending.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                log::info!("session {id} exit status {exit_status}");
            }
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) => {
                closed_reason = "远程主机关闭了会话".into();
                break;
            }
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                log::info!("session {id} exit signal {signal_name:?}");
            }
            None => {
                closed_reason = "连接已断开".into();
                break;
            }
            _ => {}
        }

        if pending.len() >= 32 * 1024 {
            let data = decode_incremental(&mut pending);
            let _ = app.emit("ssh-data", DataEvent { id: id.clone(), data });
        }
    }

    if !pending.is_empty() {
        let data = decode_incremental(&mut pending);
        let _ = app.emit("ssh-data", DataEvent { id: id.clone(), data });
    }
    let reason = if closed_reason.is_empty() { "会话已结束".to_string() } else { closed_reason };

    // 死会话必须从会话表里摘掉：只发事件不移除的话，Arc<SshSession> 一直留在
    // HashMap 里，handle / 跳板机通道都跟着不释放 —— 每次网络闪断泄漏一个。
    if let Some(st) = app.try_state::<crate::commands::AppState>() {
        let removed = st.sessions.lock().remove(&id);
        if removed.is_none() {
            log::debug!("session {id} 结束时已不在会话表（已被 ssh_close 移除）");
        }
    }
    let _ = app.emit("ssh-closed", ClosedEvent { id, reason });
}

/// 增量 UTF-8 解码：保留跨包截断的多字节尾部，避免中文乱码
fn decode_incremental(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let out = s.to_owned();
            buf.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&buf[..valid]).into_owned();
            let rest: Vec<u8> = buf[valid..].to_vec();
            buf.clear();
            let keep = if e.error_len().is_none() && rest.len() <= 3 {
                rest
            } else {
                Vec::new()
            };
            buf.extend_from_slice(&keep);
            out
        }
    }
}

static SEQ: AtomicU32 = AtomicU32::new(1);
fn next_id() -> u64 {
    let n = SEQ.fetch_add(1, Ordering::Relaxed) as u64;
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64 * 1000 + n)
        .unwrap_or(n)
}
