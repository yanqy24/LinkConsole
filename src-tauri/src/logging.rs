//! 轻量文件日志。
//!
//! 发布版是无控制台的 Windows 程序，`stderr` 会被丢弃，
//! 窗口材质回退、WebView2 设置失败这类「只在真机上才出现」的问题
//! 需要一个可回溯的落盘日志。这里用标准库实现，不引入额外依赖。
//!
//! 位置：`%LOCALAPPDATA%\LinkConsole\logs\linkconsole.log`（超过 1 MiB 时重建）。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use log::{LevelFilter, Log, Metadata, Record};

struct FileLogger {
    file: Mutex<Option<File>>,
    level: LevelFilter,
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!(
            "[{}] {:<5} {} — {}\n",
            ts,
            record.level(),
            record.target(),
            record.args()
        );
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = f.write_all(line.as_bytes());
                let _ = f.flush();
            }
        }
    }

    fn flush(&self) {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = f.flush();
            }
        }
    }
}

fn log_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    let dir = base.join("LinkConsole").join("logs");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("linkconsole.log"))
}

pub fn init() {
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|s| s.parse::<LevelFilter>().ok())
        .unwrap_or(LevelFilter::Info);

    let mut file = None;
    if let Some(path) = log_path() {
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > 1024 * 1024 {
                let _ = fs::remove_file(&path);
            }
        }
        file = OpenOptions::new().create(true).append(true).open(&path).ok();
    }

    let logger = FileLogger {
        file: Mutex::new(file),
        level,
    };
    let _ = log::set_boxed_logger(Box::new(logger));
    log::set_max_level(level);
}

#[tauri::command]
pub fn log_path_command() -> String {
    log_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}
