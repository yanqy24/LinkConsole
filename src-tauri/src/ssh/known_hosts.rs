//! 主机密钥信任库（TOFU）
//!
//! 文件位置：`%APPDATA%/<identifier>/known_hosts`，采用 OpenSSH 的 known_hosts 格式，
//! 可以直接用文本编辑器查看、也可以用 `ssh-keygen -F host` 校验。
//!
//! 行为：
//! - 首次连接某主机 → 记录服务器公钥（Trust On First Use），并写日志；
//! - 再次连接 → 与记录比对，一致才放行；
//! - 密钥变化 → 拒绝连接并给出可读原因（中间人攻击 / 主机重装都表现为这个），
//!   用户确认后可从主机右键菜单「重置主机密钥」清掉记录再重连。
//!
//! 之前这里是 `Ok(true)`（永远信任），README 声称的 TOFU 实际并不存在，
//! 中间人可以每次连接都换一把密钥而不被察觉。

use std::fs;
use std::path::{Path, PathBuf};

use russh::keys::{known_hosts as kh, PublicKey};
use tauri::{AppHandle, Manager};

/// 信任库文件路径（配置目录下的 `known_hosts`）
pub fn path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir.join("known_hosts")
}

/// 公钥指纹（SHA256，格式与 `ssh-keygen -lf` 一致）
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

/// 校验结论
pub enum Verdict {
    /// 与记录一致
    Known,
    /// 首次见到，已记录（内含刚写入的指纹）
    Learned(String),
    /// 与记录不一致，必须拒绝
    Changed {
        line: usize,
        old: String,
        new: String,
    },
}

/// 校验服务器公钥；首次见到时顺带写入信任库。
pub fn verify(path: &Path, host: &str, port: u16, key: &PublicKey) -> Verdict {
    match kh::check_known_hosts_path(host, port, key, path) {
        Ok(true) => Verdict::Known,
        Ok(false) => {
            let fp = fingerprint(key);
            if let Err(e) = kh::learn_known_hosts_path(host, port, key, path) {
                // 记录失败不阻断连接，但要留痕：否则用户以为有 TOFU 保护，实际没有
                log::error!("记录主机密钥失败（{host}:{port}）：{e}");
            }
            Verdict::Learned(fp)
        }
        Err(russh::keys::Error::KeyChanged { line }) => {
            let old = kh::known_host_keys_path(host, port, path)
                .ok()
                .and_then(|v| {
                    v.into_iter()
                        .find(|(l, _)| *l == line)
                        .map(|(_, k)| fingerprint(&k))
                })
                .unwrap_or_else(|| "（旧记录无法解析）".to_string());
            Verdict::Changed {
                line,
                old,
                new: fingerprint(key),
            }
        }
        Err(e) => {
            // 文件里有其它工具写入的异常行、权限问题等：不因为「信任库读不动」
            // 就把用户彻底挡在门外，但必须留日志说明当前没有 TOFU 保护。
            log::error!("主机密钥校验不可用（{host}:{port}），本次按信任处理：{e}");
            Verdict::Known
        }
    }
}

/// 删除某台主机的全部密钥记录，返回删除的行数。
///
/// 只处理明文主机名（含 `[host]:port` 形式）；`|1|salt|hash` 哈希条目无法反查，
/// 需要用户手工编辑文件。
pub fn forget(path: &Path, host: &str, port: u16) -> std::io::Result<usize> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let targets: Vec<String> = if port == 22 {
        vec![host.to_string()]
    } else {
        vec![format!("[{host}]:{port}"), format!("{host}:{port}")]
    };

    let mut removed = 0usize;
    let mut kept = String::with_capacity(text.len());
    for line in text.lines() {
        let head = line.split_whitespace().next().unwrap_or("");
        let hit = !head.starts_with('#')
            && head
                .split(',')
                .any(|entry| targets.iter().any(|t| entry == t.as_str()));
        if hit {
            removed += 1;
            continue;
        }
        kept.push_str(line);
        kept.push('\n');
    }

    if removed > 0 {
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, kept)?;
        fs::rename(&tmp, path)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G2sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";

    fn key(s: &str) -> PublicKey {
        russh::keys::parse_public_key_base64(s).expect("测试公钥应可解析")
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lc-kh-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("known_hosts")
    }

    #[test]
    fn tofu_records_then_matches() {
        let path = tmp("tofu");
        // 首次：记录
        assert!(matches!(
            verify(&path, "example.com", 22, &key(KEY_A)),
            Verdict::Learned(_)
        ));
        assert!(path.exists());
        // 再次：一致
        assert!(matches!(
            verify(&path, "example.com", 22, &key(KEY_A)),
            Verdict::Known
        ));
        // 同主机同端口换密钥：必须拒绝
        assert!(matches!(
            verify(&path, "example.com", 22, &key(KEY_B)),
            Verdict::Changed { .. }
        ));
        // 非标准端口是独立的记录（[host]:port）
        assert!(matches!(
            verify(&path, "example.com", 2222, &key(KEY_B)),
            Verdict::Learned(_)
        ));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn forget_removes_only_target_host() {
        let path = tmp("forget");
        let _ = verify(&path, "a.example", 22, &key(KEY_A));
        let _ = verify(&path, "b.example", 22, &key(KEY_A));
        let _ = verify(&path, "a.example", 2200, &key(KEY_A));

        assert_eq!(forget(&path, "a.example", 22).unwrap(), 1);
        // 非标准端口那条还在，因此 a.example 仍被视为已知主机
        assert!(matches!(
            verify(&path, "a.example", 2200, &key(KEY_A)),
            Verdict::Known
        ));
        // b.example 未受影响
        assert!(matches!(
            verify(&path, "b.example", 22, &key(KEY_A)),
            Verdict::Known
        ));
        // 端口 22 的记录已删除 → 重新按首次连接记录（同一把密钥）
        assert!(matches!(
            verify(&path, "a.example", 22, &key(KEY_A)),
            Verdict::Learned(_)
        ));
        // 不存在的记录返回 0
        assert_eq!(forget(&path, "nope.example", 22).unwrap(), 0);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
