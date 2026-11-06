use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};

use crate::error::{AppError, AppResult};
use crate::models::{FileEntry, TransferProgress};
use crate::ssh::SshSession;

/// 打开一个 SFTP 子系统通道（每次操作独立通道，避免与 PTY 争用）
pub async fn open_sftp(sess: &SshSession) -> AppResult<SftpSession> {
    if sess.is_closed() {
        return Err(AppError::msg("会话已断开，无法使用文件传输"));
    }
    let ch = sess.handle.channel_open_session().await?;
    ch.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(ch.into_stream()).await?;
    sftp.set_timeout(20);
    Ok(sftp)
}

fn mode_string(p: russh_sftp::protocol::FilePermissions) -> String {
    let mut s = String::with_capacity(9);
    for (r, w, x) in [
        (p.owner_read, p.owner_write, p.owner_exec),
        (p.group_read, p.group_write, p.group_exec),
        (p.other_read, p.other_write, p.other_exec),
    ] {
        s.push(if r { 'r' } else { '-' });
        s.push(if w { 'w' } else { '-' });
        s.push(if x { 'x' } else { '-' });
    }
    s
}

pub async fn list(sess: &SshSession, path: &str) -> AppResult<Vec<FileEntry>> {
    let sftp = open_sftp(sess).await?;
    let canonical = match sftp.canonicalize(path).await {
        Ok(p) => p,
        Err(_) => path.to_string(),
    };
    let mut out = Vec::new();
    let mut rd = sftp.read_dir(&canonical).await?;
    while let Some(entry) = rd.next() {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let md = entry.metadata();
        out.push(FileEntry {
            path: join_path(&canonical, &name, md.is_dir()),
            is_dir: md.is_dir(),
            size: md.len(),
            mtime: md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            mode: mode_string(md.permissions()),
        name,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn join_path(base: &str, name: &str, is_dir: bool) -> String {
    let base = base.trim_end_matches('/');
    let mut p = if base.is_empty() { format!("/{name}") } else { format!("{base}/{name}") };
    if is_dir && !p.ends_with('/') {
        p.push('/');
    }
    p
}

pub async fn mkdir(sess: &SshSession, path: &str) -> AppResult<()> {
    open_sftp(sess).await?.create_dir(path).await?;
    Ok(())
}

pub async fn remove(sess: &SshSession, path: &str, is_dir: bool) -> AppResult<()> {
    // 整棵目录树只开一次 SFTP 通道：旧实现每个条目都 open_sftp()，
    // 删除含 N 个文件的目录 ≈ N 次子系统握手，大目录会慢到无法使用。
    let sftp = open_sftp(sess).await?;
    remove_entry(&sftp, path.to_string(), is_dir, 0).await
}

/// 递归删除的最大深度：防止远端目录出现符号链接环时无限递归
const REMOVE_MAX_DEPTH: u32 = 64;

fn remove_entry<'a>(
    sftp: &'a SftpSession,
    path: String,
    is_dir: bool,
    depth: u32,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(async move {
        if depth > REMOVE_MAX_DEPTH {
            return Err(AppError::msg(format!(
                "目录层级超过 {REMOVE_MAX_DEPTH} 层，已中止（可能存在符号链接环）: {path}"
            )));
        }
        if is_dir {
            let entries: Vec<(String, bool)> = {
                let rd = sftp.read_dir(&path).await?;
                rd.map(|e| {
                    let name = e.file_name();
                    let dir = e.metadata().is_dir();
                    (join_path(&path, &name, dir), dir)
                })
                .collect()
            };
            for (child, dir) in entries {
                remove_entry(sftp, child, dir, depth + 1).await?;
            }
            sftp.remove_dir(&path).await?;
        } else {
            sftp.remove_file(&path).await?;
        }
        Ok(())
    })
}

pub async fn rename(sess: &SshSession, from: &str, to: &str) -> AppResult<()> {
    open_sftp(sess).await?.rename(from, to).await?;
    Ok(())
}

/* ============================================================
 * 传输内核：队列由前端调度，这里负责「一次传输任务」的执行，
 * 支持 暂停 / 继续 / 取消 / 断点续传。
 *
 * 续传语义（两端都按已有字节数续写，不做覆盖）：
 *   - 上传：远端同名文件存在且 0 < 远端大小 < 本地大小 → 从远端末尾继续
 *   - 下载：本地文件存在且 0 < 本地大小 < 远端大小   → 从本地末尾继续
 * 这样「取消 / 网络中断 / 应用重启后重新入队」都会自动续传。
 * ============================================================ */

/// 单个传输的控制块（前端按 transferId 操作）
#[derive(Default)]
pub struct TransferCtl {
    paused: AtomicBool,
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl TransferCtl {
    /// 检查点：取消则返回 Err；暂停则在此等待直到继续 / 取消。
    /// 每 500ms 醒一次兜底，避免通知丢失导致永久挂起。
    async fn checkpoint(&self) -> Result<(), Stop> {
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Stop::Cancelled);
            }
            if !self.paused.load(Ordering::Relaxed) {
                return Ok(());
            }
            tokio::select! {
                _ = self.notify.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        }
    }
}

enum Stop {
    Cancelled,
    Failed(String),
}

type StopResult<T> = Result<T, Stop>;

/// 传输失败原因（与「取消」区分开）
#[derive(Debug)]
pub enum Outcome {
    Done,
    Cancelled,
    Failed(String),
}

static TRANSFERS: Lazy<Mutex<HashMap<String, Arc<TransferCtl>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn register(id: &str) -> Arc<TransferCtl> {
    let ctl = Arc::new(TransferCtl::default());
    TRANSFERS.lock().insert(id.to_string(), ctl.clone());
    ctl
}

pub fn pause(id: &str) -> bool {
    match TRANSFERS.lock().get(id) {
        Some(c) => {
            c.paused.store(true, Ordering::Relaxed);
            c.notify.notify_waiters();
            true
        }
        None => false,
    }
}

pub fn resume(id: &str) -> bool {
    match TRANSFERS.lock().get(id) {
        Some(c) => {
            c.paused.store(false, Ordering::Relaxed);
            c.notify.notify_waiters();
            true
        }
        None => false,
    }
}

/// 请求取消：任务在下一个检查点退出并回收自己的注册项。
pub fn cancel(id: &str) -> bool {
    match TRANSFERS.lock().get(id) {
        Some(c) => {
            c.cancelled.store(true, Ordering::Relaxed);
            c.notify.notify_waiters();
            true
        }
        None => false,
    }
}

fn emit(
    app: &AppHandle,
    id: &str,
    state: &str,
    name: &str,
    transferred: u64,
    total: u64,
    resumed_from: u64,
    error: &str,
) {
    let _ = app.emit(
        "sftp-progress",
        TransferProgress {
            transfer_id: id.to_string(),
            name: name.to_string(),
            transferred,
            total,
            done: state == "done",
            state: state.to_string(),
            resumed_from,
            error: error.to_string(),
        },
    );
}

/// 传输上下文：把一堆参数收在一起，避免每个辅助函数都传 8 个实参
struct Ctx<'a> {
    app: &'a AppHandle,
    sftp: &'a SftpSession,
    tid: &'a str,
    ctl: &'a TransferCtl,
    total: u64,
    transferred: u64,
    resumed_from: u64,
    last_emit: Instant,
}

impl Ctx<'_> {
    fn tick(&mut self, name: &str, force: bool) {
        if force || self.last_emit.elapsed().as_millis() > 120 {
            emit(
                self.app,
                self.tid,
                "running",
                name,
                self.transferred,
                self.total,
                self.resumed_from,
                "",
            );
            self.last_emit = Instant::now();
        }
    }
}

/// 断点续传起点：已有部分内容（0 < have < full）时从其末尾继续，否则从头开始。
/// 单独抽出来是为了让这段判定可测试——它是「续传」与「覆盖」的分水岭。
fn resume_offset(have: u64, full: u64) -> u64 {
    if full > 0 && have > 0 && have < full {
        have
    } else {
        0
    }
}

fn parent_of(p: &str) -> Option<String> {
    let p = p.trim_end_matches('/');
    p.rfind('/').map(|i| {
        let s = &p[..i];
        if s.is_empty() { "/".to_string() } else { s.to_string() }
    })
}

async fn ensure_remote_dir(sftp: &SftpSession, dir: &str) -> AppResult<()> {
    let mut cur = String::new();
    for seg in dir.split('/').filter(|s| !s.is_empty()) {
        cur.push('/');
        cur.push_str(seg);
        if !sftp.try_exists(&cur).await.unwrap_or(false) {
            let _ = sftp.create_dir(&cur).await;
        }
    }
    Ok(())
}

fn collect_files(p: &Path, out: &mut Vec<PathBuf>, depth: u32) -> AppResult<()> {
    // 不跟随符号链接：既避免链接环把上传卡死在无限递归里，
    // 也避免把链接目标的内容重复上传一份
    let md = std::fs::symlink_metadata(p)?;
    if md.file_type().is_symlink() {
        log::debug!("跳过符号链接: {}", p.display());
        return Ok(());
    }
    if depth > 64 {
        return Err(AppError::msg(format!(
            "本地目录层级超过 64 层，已中止（可能存在链接环）: {}",
            p.display()
        )));
    }
    if md.is_dir() {
        let mut entries: Vec<_> = std::fs::read_dir(p)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        entries.sort();
        for e in entries {
            collect_files(&e, out, depth + 1)?;
        }
    } else {
        out.push(p.to_path_buf());
    }
    Ok(())
}

/* ---------------- 上传 ---------------- */

/// 启动一次上传（后台执行，立即返回；进度与结果全部走 `sftp-progress` 事件）
pub fn spawn_upload(app: AppHandle, sess: Arc<SshSession>, local: String, remote_dir: String, tid: String) {
    let ctl = register(&tid);
    tauri::async_runtime::spawn(async move {
        let outcome = run_upload(&app, &sess, &local, &remote_dir, &tid, &ctl).await;
        TRANSFERS.lock().remove(&tid);
        finish(&app, &tid, outcome);
    });
}

/// 启动一次下载
pub fn spawn_download(app: AppHandle, sess: Arc<SshSession>, remote: String, local: String, tid: String) {
    let ctl = register(&tid);
    tauri::async_runtime::spawn(async move {
        let outcome = run_download(&app, &sess, &remote, &local, &tid, &ctl).await;
        TRANSFERS.lock().remove(&tid);
        finish(&app, &tid, outcome);
    });
}

fn finish(app: &AppHandle, tid: &str, outcome: Outcome) {
    match outcome {
        Outcome::Done => emit(app, tid, "done", "", 0, 0, 0, ""),
        Outcome::Cancelled => emit(app, tid, "cancelled", "", 0, 0, 0, ""),
        Outcome::Failed(e) => emit(app, tid, "error", "", 0, 0, 0, &e),
    }
}

async fn run_upload(
    app: &AppHandle,
    sess: &SshSession,
    local: &str,
    remote_dir: &str,
    tid: &str,
    ctl: &TransferCtl,
) -> Outcome {
    let lp = PathBuf::from(local);
    if !lp.exists() {
        return Outcome::Failed(format!("本地路径不存在: {local}"));
    }
    let mut files: Vec<PathBuf> = Vec::new();
    if let Err(e) = collect_files(&lp, &mut files, 0) {
        return Outcome::Failed(e.to_string());
    }
    if files.is_empty() {
        return Outcome::Failed(format!(
            "没有可上传的文件（目录为空，或路径是符号链接）: {local}"
        ));
    }
    let total: u64 = files
        .iter()
        .filter_map(|f| std::fs::metadata(f).ok())
        .map(|m| m.len())
        .sum();
    let base = if lp.is_file() {
        lp.parent().unwrap_or(Path::new("/")).to_path_buf()
    } else {
        lp.clone()
    };
    let sftp = match open_sftp(sess).await {
        Ok(s) => s,
        Err(e) => return Outcome::Failed(e.to_string()),
    };
    let mut ctx = Ctx {
        app,
        sftp: &sftp,
        tid,
        ctl,
        total,
        transferred: 0,
        resumed_from: 0,
        last_emit: Instant::now() - Duration::from_millis(300),
    };

    let name0 = lp
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| local.to_string());
    ctx.tick(&name0, true);

    for f in &files {
        let rel = f.strip_prefix(&base).unwrap_or(f);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let target = join_path(remote_dir, &rel_str, false);
        if let Some(parent) = parent_of(&target) {
            if let Err(e) = ensure_remote_dir(&sftp, &parent).await {
                return Outcome::Failed(e.to_string());
            }
        }
        match copy_file_up(&mut ctx, f, &target, &rel_str).await {
            Ok(()) => {}
            Err(Stop::Cancelled) => return Outcome::Cancelled,
            Err(Stop::Failed(m)) => return Outcome::Failed(m),
        }
    }
    ctx.tick(&name0, true);
    Outcome::Done
}

async fn copy_file_up(
    ctx: &mut Ctx<'_>,
    local: &Path,
    remote: &str,
    label: &str,
) -> StopResult<()> {
    let size = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
    let mut src = tokio::fs::File::open(local)
        .await
        .map_err(|e| Stop::Failed(format!("读取本地文件失败 {label}: {e}")))?;

    // 断点续传判定：远端已有部分内容且短于本地文件；大小一致视为已完成
    let mut offset = 0u64;
    if size > 0 {
        if let Ok(md) = ctx.sftp.metadata(remote).await {
            let have = md.len();
            if have == size {
                log::info!("upload 跳过已完整的文件 {label}（{size} 字节）");
                ctx.transferred += size;
                ctx.resumed_from += size;
                ctx.tick(label, true);
                return Ok(());
            }
            offset = resume_offset(have, size);
        }
    }

    let mut dst = if offset > 0 {
        ctx.sftp
            .open_with_flags(remote, OpenFlags::WRITE)
            .await
            .map_err(|e| Stop::Failed(format!("打开远端文件失败 {label}: {e:?}")))?
    } else {
        ctx.sftp
            .open_with_flags(
                remote,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| Stop::Failed(format!("创建远端文件失败 {label}: {e:?}")))?
    };

    if offset > 0 {
        src.seek(SeekFrom::Start(offset))
            .await
            .map_err(|e| Stop::Failed(format!("定位本地文件失败: {e}")))?;
        dst.seek(SeekFrom::Start(offset))
            .await
            .map_err(|e| Stop::Failed(format!("定位远端文件失败: {e}")))?;
        ctx.transferred += offset;
        ctx.resumed_from += offset;
        log::info!("upload 续传 {label}: 从 {offset} 字节继续 (总 {size})");
        ctx.tick(label, true);
    }

    let mut buf = vec![0u8; 64 * 1024];
    loop {
        ctx.ctl.checkpoint().await?;
        let n = src
            .read(&mut buf)
            .await
            .map_err(|e| Stop::Failed(format!("读取本地文件失败 {label}: {e}")))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| Stop::Failed(format!("写入远端文件失败 {label}: {e:?}")))?;
        ctx.transferred += n as u64;
        ctx.tick(label, false);
    }
    dst.flush()
        .await
        .map_err(|e| Stop::Failed(format!("刷新远端文件失败 {label}: {e:?}")))?;
    dst.shutdown()
        .await
        .map_err(|e| Stop::Failed(format!("关闭远端文件失败 {label}: {e:?}")))?;
    Ok(())
}

/* ---------------- 下载 ---------------- */

async fn run_download(
    app: &AppHandle,
    sess: &SshSession,
    remote: &str,
    local: &str,
    tid: &str,
    ctl: &TransferCtl,
) -> Outcome {
    let sftp = match open_sftp(sess).await {
        Ok(s) => s,
        Err(e) => return Outcome::Failed(e.to_string()),
    };
    let md = match sftp.metadata(remote).await {
        Ok(m) => m,
        Err(e) => return Outcome::Failed(format!("读取远端文件信息失败: {e:?}")),
    };
    if md.is_dir() {
        return Outcome::Failed("暂不支持目录整体下载，请选择单个文件".into());
    }
    let total = md.len();
    let name = remote.rsplit('/').next().unwrap_or(remote).to_string();

    if let Some(parent) = Path::new(local).parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let mut ctx = Ctx {
        app,
        sftp: &sftp,
        tid,
        ctl,
        total,
        transferred: 0,
        resumed_from: 0,
        last_emit: Instant::now() - Duration::from_millis(300),
    };

    // 断点续传判定：本地已有部分内容且短于远端文件；大小一致视为已完成
    let mut offset = 0u64;
    if let Ok(m) = tokio::fs::metadata(local).await {
        let have = m.len();
        if total > 0 && have == total {
            log::info!("download 跳过已完整的文件 {name}（{total} 字节）");
            ctx.transferred = total;
            ctx.resumed_from = total;
            ctx.tick(&name, true);
            return Outcome::Done;
        }
        offset = resume_offset(have, total);
    }

    let mut src = match sftp.open(remote).await {
        Ok(f) => f,
        Err(e) => return Outcome::Failed(format!("打开远端文件失败: {e:?}")),
    };
    let mut dst = if offset > 0 {
        match tokio::fs::OpenOptions::new().append(true).open(local).await {
            Ok(f) => f,
            Err(e) => return Outcome::Failed(format!("打开本地文件失败: {e}")),
        }
    } else {
        match tokio::fs::File::create(local).await {
            Ok(f) => f,
            Err(e) => return Outcome::Failed(format!("创建本地文件失败: {e}")),
        }
    };

    if offset > 0 {
        if let Err(e) = src.seek(SeekFrom::Start(offset)).await {
            return Outcome::Failed(format!("定位远端文件失败: {e}"));
        }
        ctx.transferred += offset;
        ctx.resumed_from += offset;
        log::info!("download 续传 {name}: 从 {offset} 字节继续 (总 {total})");
    }
    ctx.tick(&name, true);

    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if let Err(Stop::Cancelled) = ctx.ctl.checkpoint().await {
            return Outcome::Cancelled;
        }
        let n = match src.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => return Outcome::Failed(format!("读取远端文件失败: {e:?}")),
        };
        if n == 0 {
            break;
        }
        if let Err(e) = dst.write_all(&buf[..n]).await {
            return Outcome::Failed(format!("写入本地文件失败: {e}"));
        }
        ctx.transferred += n as u64;
        ctx.tick(&name, false);
    }
    if let Err(e) = dst.flush().await {
        return Outcome::Failed(format!("刷新本地文件失败: {e}"));
    }
    ctx.tick(&name, true);
    Outcome::Done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_from_partial() {
        // 远端/本地已有 300 字节，完整 1000 字节 → 从 300 继续
        assert_eq!(resume_offset(300, 1000), 300);
    }

    #[test]
    fn full_size_is_not_resume_point() {
        // 大小一致由调用方按「已完成」跳过，这里必须返回 0（否则会从末尾续写成空文件）
        assert_eq!(resume_offset(1000, 1000), 0);
    }

    #[test]
    fn larger_existing_file_restarts() {
        // 已有文件比源还大（换了源文件 / 上次传错）→ 从头覆盖
        assert_eq!(resume_offset(2000, 1000), 0);
    }

    #[test]
    fn empty_and_zero_size() {
        assert_eq!(resume_offset(0, 1000), 0);
        assert_eq!(resume_offset(0, 0), 0);
    }
}
