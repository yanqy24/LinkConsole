use serde::{Deserialize, Serialize};

/// 代理服务器定义
///
/// kind 支持：
/// - `socks5` / `http`：常规代理（可选用户名/密码）
/// - `jump`：SSH 跳板机（XShell 的 JumpHost）。先以 SSH 登录跳板机，
///   再通过 direct-tcpip 通道转发到目标主机的 SSH 端口。
///   `host/port` 是跳板机地址，`username/password` 是跳板机凭据，
///   `auth` 可选 password（默认）或 key（`key_path` 指向私钥，`password` 作口令）。
///
/// 前端与配置文件统一使用 snake_case 键名；camelCase 别名仅为兼容
/// 早期版本写入的持久化数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct ProxyDef {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// password | key（仅 jump 类型使用）
    pub auth: String,
    /// 私钥路径（仅 jump 类型、auth=key 时使用）
    #[serde(alias = "keyPath")]
    pub key_path: String,
}

impl Default for ProxyDef {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: "socks5".into(),
            host: String::new(),
            port: 1080,
            username: String::new(),
            password: String::new(),
            auth: "password".into(),
            key_path: String::new(),
        }
    }
}

impl ProxyDef {
    pub fn is_jump(&self) -> bool {
        self.kind.eq_ignore_ascii_case("jump")
    }
}

/// 服务器（主机）定义（键名与前端保持一致的 snake_case）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct ServerDef {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub user: String,
    pub group: String,
    /// password | key
    pub auth: String,
    pub password: String,
    #[serde(alias = "keyPath")]
    pub key_path: String,
    /// 引用 ProxyDef.id，空字符串表示直连
    #[serde(alias = "proxyId")]
    pub proxy_id: String,
    pub os: String,
}

impl Default for ServerDef {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            ip: String::new(),
            port: 22,
            user: "root".into(),
            group: "默认分组".into(),
            auth: "password".into(),
            password: String::new(),
            key_path: String::new(),
            proxy_id: String::new(),
            os: "Linux".into(),
        }
    }
}

impl ServerDef {
    pub fn proxy_label<'a>(&self, proxies: &'a [ProxyDef]) -> Option<&'a ProxyDef> {
        if self.proxy_id.is_empty() {
            None
        } else {
            proxies.iter().find(|p| p.id == self.proxy_id)
        }
    }
}

/// 快捷命令
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuickCmd {
    pub label: String,
    pub cmd: String,
}

impl Default for QuickCmd {
    fn default() -> Self {
        Self {
            label: String::new(),
            cmd: String::new(),
        }
    }
}

/// 终端设置由前端定义结构，后端透传存储
pub type SettingsValue = serde_json::Value;

/// 应用配置（持久化到 %APPDATA%/com.linkconsole.app/linkconsole.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub servers: Vec<ServerDef>,
    pub groups: Vec<String>,
    pub proxies: Vec<ProxyDef>,
    pub quick_commands: Vec<QuickCmd>,
    /// 历史命令（前端只保留最近 20 条）
    #[serde(default)]
    pub history: Vec<String>,
    pub settings: SettingsValue,
}

/// 全新安装时不预置任何主机、分组、代理或快捷命令——界面保持空白，
/// 由用户自行创建（避免把演示数据当成真实资产）。
impl Default for AppConfig {
    fn default() -> Self {
        Self {
            servers: vec![],
            groups: vec![],
            proxies: vec![],
            quick_commands: vec![],
            history: vec![],
            settings: serde_json::json!({
                "theme": "dark",
                "pure": true,
                "material": "auto",
                "fontFamily": "Consolas, 'JetBrains Mono', 'Cascadia Mono', monospace",
                "fontSize": 13,
                "bufferLines": 5000,
                "prefixMode": "name",
                "multiGuard": true,
                "showQuickBar": true,
                "showHistoryBar": true,
                "filesWidth": 302,
                "sessionsWidth": 246
            }),
        }
    }
}

/// 会话信息（返回给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub ip: String,
    pub user: String,
    pub port: u16,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
    pub mode: String,
}

/// 传输进度事件
///
/// `state` 是权威状态（frontend 队列按它推进）：
/// `running` | `paused` | `done` | `cancelled` | `error`
/// `done` 仅为兼容旧前端保留（等价于 state == "done"）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub name: String,
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
    pub state: String,
    /// 本次从多少字节处续传（0 = 从头开始），用于前端提示「续传自 xx」
    #[serde(default)]
    pub resumed_from: u64,
    #[serde(default)]
    pub error: String,
}
