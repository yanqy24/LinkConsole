//! 桌面化：WebView2 行为收敛 + 窗口材质（Mica / Acrylic）。
//!
//! 目标是让窗口像「原生桌面程序」而不是「网页」：
//! - 关掉 WebView2 自带的右键菜单（刷新/另存为/检查…），改由应用的原生菜单接管；
//! - 关掉浏览器加速键（Ctrl+P 打印、Ctrl+J 下载、F3 查找、F7 光标浏览…），快捷键由应用自己定义；
//! - 关掉缩放控件与状态栏，避免右下角出现网页式的缩放浮层和链接悬停地址条。

use tauri::WebviewWindow;

/// WebView2 层设置。只在 Windows 生效，失败静默（不影响主流程）。
#[cfg(windows)]
pub fn tune_webview(window: &WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let result = window.with_webview(|platform| unsafe {
        let controller = platform.controller();
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(_) => return,
        };
        let settings = match core.Settings() {
            Ok(s) => s,
            Err(_) => return,
        };
        // 基础设置：默认右键菜单、状态栏、缩放
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        let _ = settings.SetIsStatusBarEnabled(false);
        let _ = settings.SetIsZoomControlEnabled(false);
        // 加速键（Settings3 才有）
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
        log::info!("WebView2 行为已收敛：默认右键菜单 / 浏览器加速键 / 缩放控件已关闭");
    });

    if let Err(e) = result {
        log::warn!("WebView2 设置失败：{e}");
    }
}

#[cfg(not(windows))]
pub fn tune_webview(_window: &WebviewWindow) {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Material {
    Mica,
    Acrylic,
    Solid,
}

impl Material {
    pub fn as_str(self) -> &'static str {
        match self {
            Material::Mica => "mica",
            Material::Acrylic => "acrylic",
            Material::Solid => "solid",
        }
    }

    pub fn parse(s: &str) -> Material {
        match s {
            "mica" => Material::Mica,
            "acrylic" => Material::Acrylic,
            "solid" => Material::Solid,
            _ => Material::Mica, // auto
        }
    }
}

fn clear_all(window: &WebviewWindow) {
    let _ = window_vibrancy::clear_mica(window);
    let _ = window_vibrancy::clear_acrylic(window);
}

/// 应用窗口材质，返回实际生效的材质。
///
/// 顺序：Mica（Win11 22000+）→ 失败回退 Acrylic（Win10 1809+）→ 再失败就纯色。
/// Acrylic 在 Win10 上会明显拖慢窗口拖动/缩放，所以「纯色」始终是可用的兜底，
/// 并且用户可以在设置里手动选「纯色」以换取帧率。
pub fn apply_material(window: &WebviewWindow, want: Material, dark: bool) -> Material {
    clear_all(window);

    let acrylic_tint = Some((16, 18, 24, if dark { 160 } else { 120 }));

    match want {
        Material::Solid => Material::Solid,
        Material::Acrylic => {
            if window_vibrancy::apply_acrylic(window, acrylic_tint).is_ok() {
                Material::Acrylic
            } else {
                Material::Solid
            }
        }
        Material::Mica => match window_vibrancy::apply_mica(window, Some(dark)) {
            Ok(()) => Material::Mica,
            Err(e) => {
                log::info!("Mica 不可用（{e}），回退 Acrylic");
                if window_vibrancy::apply_acrylic(window, acrylic_tint).is_ok() {
                    Material::Acrylic
                } else {
                    Material::Solid
                }
            }
        },
    }
}

#[tauri::command]
pub fn set_window_material(
    window: WebviewWindow,
    material: String,
    dark: bool,
) -> Result<String, String> {
    let want = Material::parse(&material);
    let applied = apply_material(&window, want, dark);
    log::info!("窗口材质：{material} → {}", applied.as_str());
    Ok(applied.as_str().to_string())
}

/// 启动时在后台线程里收敛 WebView2 行为。
/// 放到独立线程是因为 `with_webview` 需要把闭包投递到主线程执行，
/// 在 setup（主线程、事件循环尚未开始）里同步调用有死锁风险。
pub fn init_window(window: WebviewWindow) {
    std::thread::spawn(move || {
        tune_webview(&window);
    });
}
