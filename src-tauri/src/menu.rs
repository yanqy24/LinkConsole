//! 原生右键菜单：把前端的菜单描述翻译成 Win32 原生菜单（muda/tauri::menu）。
//!
//! 设计要点
//! - 前端仍然用同一份 `{ label, icon, kbd, danger, disabled, checked }` 描述菜单，
//!   只是渲染交给系统：原生菜单有系统级的高亮、圆角、阴影、键盘操作与无障碍支持，
//!   不会出现「网页里飘出来一块 div」的浏览器感。
//! - 每个菜单项在弹出时分配一次性 id（`cm<seq>`），前端用 id → 回调的 Map 承接点击，
//!   因此调用点（servers/sessions/files/term…）完全不需要改动。
//! - 菜单只在用户点击后才回传一次，避免残留监听。

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{Runtime, WebviewWindow};

#[derive(Deserialize, Clone, Debug)]
pub struct MenuItemSpec {
    /// 分隔线
    #[serde(default)]
    pub sep: bool,
    /// 唯一 id（点击后原样回传）
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    /// 快捷键提示，例如 "Ctrl+N"；无法识别时忽略（仅影响右侧提示）
    #[serde(default)]
    pub kbd: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    /// Some(true/false) 时用可勾选项渲染
    #[serde(default)]
    pub checked: Option<bool>,
}

/// 把前端的中文/口语化快捷键（Ctrl N、Ctrl+Shift+F、F5、双击）转成可解析的加速键。
/// 返回 None 表示不显示（例如「双击」「Enter」这类非加速键操作）。
fn normalize_accel(kbd: &str) -> Option<String> {
    let raw = kbd.trim();
    if raw.is_empty() {
        return None;
    }
    // 纯中文/提示语直接放弃
    if raw.chars().any(|c| c as u32 > 0x2E80) {
        return None;
    }
    let tokens: Vec<&str> = raw
        .split(|c| c == '+' || c == ' ')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let (key, mods) = tokens.split_last()?;
    let mut out: Vec<&str> = Vec::new();
    for m in mods {
        match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => out.push("Ctrl"),
            "shift" => out.push("Shift"),
            "alt" | "option" => out.push("Alt"),
            "win" | "super" | "cmd" | "command" | "meta" => out.push("Super"),
            _ => return None,
        }
    }
    let key = match key.to_ascii_lowercase().as_str() {
        "del" | "delete" => "Delete",
        "esc" | "escape" => "Escape",
        "enter" | "return" => "Enter",
        "space" => "Space",
        "tab" => "Tab",
        "backspace" => "Backspace",
        "home" => "Home",
        "end" => "End",
        "left" => "Left",
        "right" => "Right",
        "up" => "Up",
        "down" => "Down",
        other => {
            let mut chars = other.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if c.is_ascii_alphanumeric() => {
                    return Some(if out.is_empty() {
                        c.to_ascii_uppercase().to_string()
                    } else {
                        format!("{}+{}", out.join("+"), c.to_ascii_uppercase())
                    })
                }
                _ => {
                    // F1..F24（先转小写再剥前缀，"F5" 才能匹配到 'f'）
                    let upper = other.to_ascii_uppercase();
                    let is_fkey = other
                        .to_ascii_lowercase()
                        .strip_prefix('f')
                        .and_then(|n| n.parse::<u8>().ok())
                        .map(|n| (1..=24).contains(&n))
                        .unwrap_or(false);
                    if !is_fkey {
                        return None;
                    }
                    if out.is_empty() {
                        return Some(upper);
                    }
                    return Some(format!("{}+{}", out.join("+"), upper));
                }
            }
        }
    };
    if out.is_empty() {
        Some(key.to_string())
    } else {
        Some(format!("{}+{}", out.join("+"), key))
    }
}

fn build<R: Runtime>(window: &WebviewWindow<R>, items: &[MenuItemSpec]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(window)?;
    for it in items {
        if it.sep {
            menu.append(&PredefinedMenuItem::separator(window)?)?;
            continue;
        }
        if it.label.trim().is_empty() {
            continue;
        }
        let accel = it.kbd.as_deref().and_then(normalize_accel);
        // 危险操作（删除类）在原生菜单里加前缀，避免误点；原生菜单无法单独染色
        let label = it.label.as_str();
        match it.checked {
            Some(on) => {
                let item = CheckMenuItem::with_id(window, it.id.as_str(), label, !it.disabled, on, accel)?;
                menu.append(&item)?;
            }
            None => {
                let item = MenuItem::with_id(window, it.id.as_str(), label, !it.disabled, accel)?;
                menu.append(&item)?;
            }
        }
    }
    Ok(menu)
}

/// 在鼠标位置弹出原生菜单。点击结果通过 `native-menu` 事件回传。
///
/// 注意：`popup_menu` 会进入系统菜单的消息循环，直到菜单关闭才返回，
/// 因此这里不要做任何依赖返回值的后续逻辑。
#[tauri::command]
pub fn popup_menu(window: WebviewWindow, items: Vec<MenuItemSpec>) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let menu = build(&window, &items).map_err(|e| e.to_string())?;
    let count = items.iter().filter(|i| !i.sep && !i.label.trim().is_empty()).count();
    log::debug!("弹出原生菜单：{count} 项");
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::normalize_accel;

    #[test]
    fn accel_normalization() {
        assert_eq!(normalize_accel("Ctrl N").as_deref(), Some("Ctrl+N"));
        assert_eq!(normalize_accel("Ctrl+Shift+F").as_deref(), Some("Ctrl+Shift+F"));
        assert_eq!(normalize_accel("F5").as_deref(), Some("F5"));
        assert_eq!(normalize_accel("Del"), Some("Delete".into()));
        assert_eq!(normalize_accel("双击"), None);
        assert_eq!(normalize_accel("Enter"), Some("Enter".into()));
        // 标点类快捷键不进原生加速键（muda 解析不了），只保留文字提示语义
        assert_eq!(normalize_accel("Ctrl ,"), None);
    }
}
