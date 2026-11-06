use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::models::AppConfig;

/// 配置内容没保住时（读不出、也无法改名/复制备份）置位，阻止 save 覆盖原文件
static SAVE_BLOCKED: AtomicBool = AtomicBool::new(false);

/// 配置文件路径：`%APPDATA%/<identifier>/linkconsole.json`
pub fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir.join("linkconsole.json")
}

pub fn load(app: &AppHandle) -> AppConfig {
    let path = config_path(app);
    // 按字节读取：编辑器加的 UTF-8 BOM、个别非法字节都能在这里救回来，
    // 用 read_to_string 的话这些情况会直接变成「读取失败」。
    match fs::read(&path) {
        Ok(bytes) => match parse_config(&bytes) {
            Ok(cfg) => cfg,
            Err(e) => {
                log::error!("配置文件解析失败: {e}");
                // 解析失败绝不能直接丢弃：下一次 save 会用默认配置把原文件整份覆盖，
                // 用户的主机 / 密码 / 代理就静默消失了。先改名备份，保留现场。
                preserve_broken(&path, "解析失败");
                AppConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 真正的「首次启动」才写默认配置
            let cfg = AppConfig::default();
            let _ = save(app, &cfg);
            cfg
        }
        Err(e) => {
            // 权限不足 / 文件被占用等：内容可能完好，绝不能直接用默认配置覆盖掉。
            log::error!("读取配置失败（{}）: {e}", path.display());
            preserve_broken(&path, "读取失败");
            AppConfig::default()
        }
    }
}

/// 解析配置字节流：容忍 UTF-8 BOM 与个别非法字节。
///
/// 编辑器加 BOM、磁盘/同步工具写坏一两个字节，都不应该让整份配置「被判死刑」；
/// 能解析出来就用，解析不出来才走备份 + 默认配置。
fn parse_config(bytes: &[u8]) -> Result<AppConfig, serde_json::Error> {
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
}

/// 把无法使用的配置改名（失败则复制）为 `.bad-<ts>`，尽量保住用户数据。
///
/// 返回 true 表示现场已保住；false 表示既不能改名也不能复制（如权限不足），
/// 此时调用方必须避免覆盖原文件。
fn preserve_broken(path: &std::path::Path, why: &str) -> bool {
    if !path.exists() {
        return true;
    }
    let bak = backup_path(path);
    match fs::rename(path, &bak) {
        Ok(_) => {
            log::warn!("配置{why}，已备份为 {}", bak.display());
            true
        }
        Err(err) => {
            log::error!("备份损坏配置失败（{err}），改为复制副本");
            match fs::copy(path, &bak) {
                Ok(_) => {
                    log::warn!("已复制配置副本到 {}", bak.display());
                    true
                }
                Err(e2) => {
                    log::error!("复制配置副本也失败: {e2}");
                    // 关键：内容没保住时，宁可这次不保存也不能覆盖用户数据
                    SAVE_BLOCKED.store(true, std::sync::atomic::Ordering::Relaxed);
                    false
                }
            }
        }
    }
}

/// 损坏配置的备份文件名：`linkconsole.json.bad-<unix 秒>`，同名不覆盖
fn backup_path(path: &std::path::Path) -> PathBuf {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let bak = path.with_extension(format!("json.bad-{secs}"));
    if bak.exists() {
        return path.with_extension(format!("json.bad-{secs}-{}", std::process::id()));
    }
    bak
}

pub fn save(app: &AppHandle, cfg: &AppConfig) -> AppResult<()> {
    if SAVE_BLOCKED.load(std::sync::atomic::Ordering::Relaxed) {
        log::error!("配置文件既无法读取也无法备份，已拒绝覆盖（请先修复磁盘/权限问题）");
        return Err(crate::error::AppError::msg(
            "配置文件无法读取且备份失败，为避免丢失数据已暂停保存；请检查配置目录权限",
        ));
    }
    let path = config_path(app);
    let text = serde_json::to_string_pretty(cfg)?;
    // 先写临时文件再原子替换，避免写入中断导致配置损坏
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &[u8] =
        br#"{"servers":[{"id":"a","name":"A","ip":"192.0.2.1","user":"root"}],"settings":{}}"#;

    #[test]
    fn parses_plain_json() {
        let cfg = parse_config(JSON).expect("正常配置应可解析");
        assert_eq!(cfg.servers.len(), 1);
        assert_eq!(cfg.servers[0].ip, "192.0.2.1");
    }

    #[test]
    fn tolerates_utf8_bom() {
        // 以前 BOM 会让解析失败 → 备份 + 空配置，用户以为「主机全没了」
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(JSON);
        let cfg = parse_config(&bom).expect("BOM 应被忽略");
        assert_eq!(cfg.servers.len(), 1);
    }

    #[test]
    fn tolerates_invalid_utf8_bytes() {
        // 个别坏字节（磁盘/同步工具造成）只应影响那一个字符，不该整份丢弃
        let mut buf = b"{\"servers\":[{\"id\":\"a\",\"name\":\"".to_vec();
        buf.push(0xFF);
        buf.extend_from_slice(b"\",\"ip\":\"192.0.2.1\"}],\"settings\":{}}");
        let cfg = parse_config(&buf).expect("非法 UTF-8 字节不应让整份配置失败");
        assert_eq!(cfg.servers.len(), 1);
        assert_eq!(cfg.servers[0].ip, "192.0.2.1");
    }
}
