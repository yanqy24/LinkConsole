use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::{AppError, AppResult};
use crate::models::ProxyDef;
use crate::ssh::ClientHandler;

/// 抹平 TCP 与「SSH direct-tcpip 通道」差异的动态流
pub trait AsyncReadWrite: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> AsyncReadWrite for T {}
pub type DynStream = Box<dyn AsyncReadWrite>;
/// 跳板机会话保活：目标连接关闭前必须持有，否则跳板机连接随之断开
pub type JumpKeep = Arc<russh::client::Handle<ClientHandler>>;

/// 建立到目标 `host:port` 的底层连接（含代理/跳板机握手）。
/// 返回可用于 SSH 握手的流；jump 类型同时返回需要保活的跳板机会话。
pub async fn dial(
    host: &str,
    port: u16,
    proxy: Option<&ProxyDef>,
    known_hosts: &Path,
) -> AppResult<(DynStream, Option<JumpKeep>)> {
    match proxy {
        None => {
            let stream = tokio::time::timeout(
                Duration::from_secs(12),
                TcpStream::connect((host, port)),
            )
            .await
            .map_err(|_| AppError::msg("连接超时（12s）"))?
            .map_err(|e| AppError::msg(format!("无法连接 {host}:{port} — {e}")))?;
            let _ = stream.set_nodelay(true);
            Ok((Box::new(stream), None))
        }
        Some(p) if p.is_jump() => {
            let (stream, keep) = jump_dial(p, host, port, known_hosts).await?;
            Ok((Box::new(stream), Some(keep)))
        }
        Some(p) => {
            let stream = tokio::time::timeout(
                Duration::from_secs(12),
                TcpStream::connect((p.host.as_str(), p.port)),
            )
            .await
            .map_err(|_| AppError::msg("连接代理超时（12s）"))?
            .map_err(|e| AppError::msg(format!("无法连接代理 {}:{} — {}", p.host, p.port, e)))?;
            let _ = stream.set_nodelay(true);
            let stream = match p.kind.as_str() {
                "http" => {
                    tokio::time::timeout(Duration::from_secs(10), http_connect(stream, host, port, p))
                        .await
                        .map_err(|_| AppError::msg("HTTP 代理握手超时（10s）"))??
                }
                _ => {
                    tokio::time::timeout(Duration::from_secs(10), socks5_connect(stream, host, port, p))
                        .await
                        .map_err(|_| AppError::msg("SOCKS5 代理握手超时（10s）"))??
                }
            };
            Ok((Box::new(stream), None))
        }
    }
}

/// XShell JumpHost 语义：SSH 登录跳板机 → 在跳板机上打开到目标的
/// direct-tcpip 通道 → 该通道即为到目标主机 22 端口的裸流。
async fn jump_dial(
    p: &ProxyDef,
    host: &str,
    port: u16,
    known_hosts: &Path,
) -> AppResult<(DynStream, JumpKeep)> {
    let handle = jump_login(p, known_hosts).await?;
    let channel = jump_forward(&handle, host, port).await?;
    let keep: JumpKeep = Arc::new(handle);
    Ok((Box::new(channel.into_stream()), keep))
}

/// 登录跳板机：TCP 连接 + SSH 握手 + 认证。每一步都有超时，绝不无限等待。
/// 跳板机同样走主机密钥校验（以前复用 `Ok(true)` 的 handler，等于完全跳过）。
async fn jump_login(
    p: &ProxyDef,
    known_hosts: &Path,
) -> AppResult<russh::client::Handle<ClientHandler>> {
    let jump_stream = tokio::time::timeout(
        Duration::from_secs(12),
        TcpStream::connect((p.host.as_str(), p.port)),
    )
    .await
    .map_err(|_| AppError::msg("连接跳板机超时（12s）"))?
    .map_err(|e| AppError::msg(format!("无法连接跳板机 {}:{} — {}", p.host, p.port, e)))?;
    let _ = jump_stream.set_nodelay(true);

    let handler = ClientHandler::new(p.host.clone(), p.port, known_hosts.to_path_buf());
    let reject = handler.reject_slot();
    let handshake = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect_stream(crate::ssh::ssh_config(), jump_stream, handler),
    )
    .await
    .map_err(|_| AppError::msg("跳板机 SSH 握手超时（15s）"))?;
    let mut handle: russh::client::Handle<ClientHandler> = match handshake {
        Ok(h) => h,
        Err(e) => match reject.lock().take() {
            Some(msg) => return Err(AppError::msg(format!("跳板机{}", msg))),
            None => return Err(AppError::msg(format!("跳板机 SSH 握手失败: {e}"))),
        },
    };

    tokio::time::timeout(Duration::from_secs(15), authenticate_jump(&mut handle, p))
        .await
        .map_err(|_| AppError::msg("跳板机认证超时（15s）"))??;
    Ok(handle)
}

/// 在跳板机上打开到目标 `host:port` 的 direct-tcpip 通道
async fn jump_forward(
    handle: &russh::client::Handle<ClientHandler>,
    host: &str,
    port: u16,
) -> AppResult<russh::Channel<russh::client::Msg>> {
    tokio::time::timeout(
        Duration::from_secs(10),
        handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0),
    )
    .await
    .map_err(|_| {
        AppError::msg(format!(
            "跳板机转发到 {host}:{port} 超时（10s，目标可能不可达或被策略阻断）"
        ))
    })?
    .map_err(|e| {
        AppError::msg(format!(
            "跳板机无法转发到 {host}:{port}（检查目标可达性与跳板机 AllowTcpForwarding）: {e:?}"
        ))
    })
}

/// 跳板机认证：密码或私钥（私钥口令复用 password 字段）
async fn authenticate_jump(
    handle: &mut russh::client::Handle<ClientHandler>,
    p: &ProxyDef,
) -> AppResult<()> {
    let user = if p.username.is_empty() { "root" } else { p.username.as_str() };
    let authed = if p.auth == "key" && !p.key_path.is_empty() {
        let pwd = if p.password.is_empty() { None } else { Some(p.password.as_str()) };
        let key = russh::keys::load_secret_key(&p.key_path, pwd)
            .map_err(|e| AppError::msg(format!("读取跳板机私钥失败: {e:?}")))?;
        let hash: Option<Option<russh::keys::HashAlg>> = handle.best_supported_rsa_hash().await?;
        let kph = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash.flatten());
        handle.authenticate_publickey(user, kph).await?
    } else {
        handle.authenticate_password(user, &p.password).await?
    };
    if !authed.success() {
        let _ = handle.disconnect(russh::Disconnect::AuthCancelledByUser, "auth failed", "en");
        return Err(AppError::msg(format!(
            "跳板机认证失败：用户 `{}` 的凭据被拒绝",
            user
        )));
    }
    Ok(())
}

/// SOCKS5 方法协商 +（可选）用户名密码认证。不发起 CONNECT，
/// 因此「测试连接」不受代理出口策略影响，仅验证代理本身可用。
async fn socks5_handshake(stream: &mut TcpStream, p: &ProxyDef) -> AppResult<()> {
    let with_auth = !p.username.is_empty();
    let methods: &[u8] = if with_auth { &[0x00, 0x02] } else { &[0x00] };
    let mut greet = vec![0x05u8, methods.len() as u8];
    greet.extend_from_slice(methods);
    stream.write_all(&greet).await?;

    let mut resp = [0u8; 2];
    stream.read_exact(&mut resp).await?;
    if resp[0] != 0x05 {
        return Err(AppError::msg("SOCKS5 代理协议版本不匹配"));
    }
    if resp[1] == 0x02 {
        // 用户名/密码子协商 (RFC 1929)
        if !with_auth {
            return Err(AppError::msg("SOCKS5 代理要求认证，但未填写用户名/密码"));
        }
        let mut sub = vec![0x01u8];
        sub.push(p.username.len() as u8);
        sub.extend_from_slice(p.username.as_bytes());
        sub.push(p.password.len() as u8);
        sub.extend_from_slice(p.password.as_bytes());
        stream.write_all(&sub).await?;
        let mut r = [0u8; 2];
        stream.read_exact(&mut r).await?;
        if r[1] != 0x00 {
            return Err(AppError::msg("SOCKS5 代理认证失败（用户名或密码错误）"));
        }
    } else if resp[1] != 0x00 {
        return Err(AppError::msg("SOCKS5 代理不接受无认证方式"));
    }
    Ok(())
}

async fn socks5_connect(
    mut stream: TcpStream,
    host: &str,
    port: u16,
    p: &ProxyDef,
) -> AppResult<TcpStream> {
    socks5_handshake(&mut stream, p).await?;

    let mut req = vec![0x05u8, 0x01, 0x00, 0x03, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&req).await?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await?;
    if head[1] != 0x00 {
        return Err(AppError::msg(format!(
            "SOCKS5 代理连接失败，代码 {}（{}）",
            head[1],
            socks_err(head[1])
        )));
    }
    let skip = match head[3] {
        0x01 => 4 + 2,
        0x03 => 1 + 2,
        0x04 => 16 + 2,
        _ => return Err(AppError::msg("SOCKS5 代理返回未知地址类型")),
    };
    let mut rest = vec![0u8; skip];
    stream.read_exact(&mut rest).await?;
    Ok(stream)
}

fn socks_err(c: u8) -> &'static str {
    match c {
        0x01 => "一般性失败",
        0x02 => "规则不允许",
        0x03 => "网络不可达",
        0x04 => "主机不可达",
        0x05 => "连接被拒绝",
        0x06 => "TTL 超时",
        0x07 => "不支持的命令",
        0x08 => "不支持的地址类型",
        _ => "未知错误",
    }
}

async fn http_connect(
    mut stream: TcpStream,
    host: &str,
    port: u16,
    p: &ProxyDef,
) -> AppResult<TcpStream> {
    let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if !p.username.is_empty() {
        use std::fmt::Write as _;
        let cred = format!("{}:{}", p.username, p.password);
        let b64 = base64_encode(cred.as_bytes());
        let _ = write!(req, "Proxy-Authorization: Basic {b64}\r\n");
    }
    req.push_str("Proxy-Connection: keep-alive\r\n\r\n");
    stream.write_all(req.as_bytes()).await?;

    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 256];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(AppError::msg("HTTP 代理连接被提前关闭"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 8192 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let status = text
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .to_string();
    if status != "200" {
        return Err(AppError::msg(format!("HTTP 代理返回状态 {status}，连接被拒绝")));
    }
    Ok(stream)
}

/// 极简 base64（标准字母表 + padding）
pub fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 解析 "host:port" / "[ipv6]:port"
pub fn parse_addr(s: &str, default_port: u16) -> AppResult<(String, u16)> {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('[') {
        let end = rest
            .find(']')
            .ok_or_else(|| AppError::msg("IPv6 地址缺少右中括号"))?;
        let host = rest[..end].to_string();
        let port = rest[end + 1..]
            .trim_start_matches(':')
            .parse()
            .unwrap_or(default_port);
        return Ok((host, port));
    }
    match s.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() => Ok((
            h.to_string(),
            p.parse().map_err(|_| AppError::msg(format!("端口 `{p}` 无效")))?,
        )),
        _ => Ok((s.to_string(), default_port)),
    }
}

/// 代理「测试连接」的结果。
///
/// `level` 为 `ok` 或 `warn`：warn 表示代理服务本身可达，但转发测试没通过
/// （常见于出口白名单 / 只允许内网的代理），这类情况不应该让用户误以为配置写错。
#[derive(Debug, serde::Serialize)]
pub struct ProbeReport {
    pub level: String,
    pub message: String,
}

impl ProbeReport {
    fn ok<S: Into<String>>(msg: S) -> Self {
        Self { level: "ok".into(), message: msg.into() }
    }
    fn warn<S: Into<String>>(msg: S) -> Self {
        Self { level: "warn".into(), message: msg.into() }
    }
}

/// 只验证代理 / 跳板机自身可用性，不需要用户填写「测试目标」：
/// - SOCKS5：TCP + 方法协商 + 认证（不发 CONNECT，不受出口策略影响）
/// - HTTP CONNECT：TCP + 认证探测（固定探针目标，403/407 会区分说明）
/// - JUMPHOST：SSH 登录 + 认证（不打开转发通道）
pub async fn probe_proxy(p: &ProxyDef, known_hosts: &Path) -> AppResult<ProbeReport> {
    if p.host.trim().is_empty() {
        return Err(AppError::msg("请填写代理 IP / 域名"));
    }
    if p.is_jump() {
        let handle = jump_login(p, known_hosts).await?;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "probe done", "en")
            .await;
        return Ok(ProbeReport::ok(format!(
            "跳板机 {}:{} 登录成功（SSH 认证通过）",
            p.host, p.port
        )));
    }

    let stream = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect((p.host.as_str(), p.port)),
    )
    .await
    .map_err(|_| AppError::msg(format!("连接代理超时（10s）：{}:{}", p.host, p.port)))?
    .map_err(|e| AppError::msg(format!("无法连接代理 {}:{} — {e}", p.host, p.port)))?;
    let _ = stream.set_nodelay(true);

    if p.kind == "http" {
        // HTTP 代理没有「只握手」的概念，必须发一次 CONNECT 才能验证凭据。
        // 探针目标固定，不占用配置项；失败时按状态码给出可操作的结论。
        const PROBE_HOST: &str = "www.baidu.com";
        const PROBE_PORT: u16 = 443;
        let r = tokio::time::timeout(
            Duration::from_secs(8),
            http_connect(stream, PROBE_HOST, PROBE_PORT, p),
        )
        .await;
        return match r {
            Ok(Ok(_)) => Ok(ProbeReport::ok(format!(
                "HTTP 代理 {}:{} 连接成功（认证通过）",
                p.host, p.port
            ))),
            Ok(Err(e)) if e.0.contains("407") => Err(AppError::msg(
                "HTTP 代理认证失败（407）：请检查用户名与密码",
            )),
            Ok(Err(e)) => Ok(ProbeReport::warn(format!(
                "HTTP 代理 {}:{} 可达（TCP 已连通），但转发测试未通过：{e}；若该代理只允许访问内网，可忽略此提示",
                p.host, p.port
            ))),
            Err(_) => Ok(ProbeReport::warn(format!(
                "HTTP 代理 {}:{} 可达（TCP 已连通），转发测试超时；若该代理只允许访问内网，可忽略此提示",
                p.host, p.port
            ))),
        };
    }

    let mut stream = stream;
    tokio::time::timeout(Duration::from_secs(8), socks5_handshake(&mut stream, p))
        .await
        .map_err(|_| AppError::msg("SOCKS5 代理握手超时（8s）"))??;
    Ok(ProbeReport::ok(if p.username.is_empty() {
        format!("SOCKS5 代理 {}:{} 握手成功", p.host, p.port)
    } else {
        format!("SOCKS5 代理 {}:{} 握手成功（认证通过）", p.host, p.port)
    }))
}

/// 用于 "测试连接"：仅验证 TCP/代理/跳板机可达性（含完整协议握手）
pub async fn probe(addr: &str, proxy: Option<&ProxyDef>, known_hosts: &Path) -> AppResult<String> {
    let (host, port) = parse_addr(addr, 22)?;

    // 跳板机分两步报告：登录成功但转发失败是常见情况，要让用户能区分
    if let Some(p) = proxy.filter(|p| p.is_jump()) {
        let handle = jump_login(p, known_hosts).await?;
        match jump_forward(&handle, &host, port).await {
            Ok(_channel) => {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "probe done", "en")
                    .await;
                return Ok(format!(
                    "跳板机 {}:{} 登录成功，已转发至 {host}:{port}",
                    p.host, p.port
                ));
            }
            Err(e) => {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "probe failed", "en")
                    .await;
                return Err(AppError::msg(format!(
                    "跳板机 {}:{} 登录成功，但转发失败：{e}",
                    p.host, p.port
                )));
            }
        }
    }

    let label = match proxy {
        None => "直连".to_string(),
        Some(p) => format!("经 {} {}:{}", p.kind.to_uppercase(), p.host, p.port),
    };
    // 兜底总超时：任何一步卡住都给出明确结论，而不是让界面一直「测试中…」
    let (_, keep) = tokio::time::timeout(
        Duration::from_secs(25),
        dial(&host, port, proxy, known_hosts),
    )
        .await
        .map_err(|_| AppError::msg(format!("测试超时（25s）：{label} → {host}:{port} 无响应")))??;
    drop(keep);
    Ok(format!("{label} → {host}:{port} 握手成功"))
}
