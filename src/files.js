/**
 * 可视文件管理：SFTP 目录浏览 / 上传（含拖拽）/ 下载 / 新建 / 删除 / 重命名
 */
import { state, byServer, active, getServer, persistSoon } from './state.js';
import { invoke, IN_TAURI } from './api.js';
import { $, h, esc, toast, fmtSize, fmtTime, openCtx, menuIcon, hideTooltip } from './ui.js';
// 目录缓存由工作区维护（SFTP 读写后要清掉，否则文件面板会显示过期的目录内容）
import { invalidateDirCache } from './workspace.js';

let dragBound = false;

function sess() {
  const s = active();
  return s && s.status === 'open' ? s : state.sessions.find((x) => x.status === 'open') || null;
}

/**
 * 文件面板内容所属的会话。
 * 面板显示的是哪台主机的目录，后续操作就必须发给哪台主机——不能跟着「当前活动
 * 会话」漂移，否则浏览 A 时切到 B，删除就落到 B 上了。
 */
function panelSess() {
  const sid = state.files.sid;
  // 面板刚打开、首次读取尚未发起时还没有归属，退回当前会话
  if (!sid) return sess();
  const s = state.sessions.find((x) => x.id === sid);
  return s && s.status === 'open' ? s : null;
}

/** 操作前的守卫：面板所属会话不可用就明确拒绝，并收起面板 */
function needPanelSess() {
  const s = panelSess();
  if (s) return s;
  toast('文件面板所属的主机会话已断开，请重新打开文件管理', 'warn', 4000);
  closeFiles();
  return null;
}

export function toggleFiles() {
  const p = $('#filePanel');
  if (p.classList.contains('open')) { closeFiles(); return; }
  openFiles();
}

function closeFiles() {
  const p = $('#filePanel');
  p.classList.remove('open');
  // 清掉拖拽写入的内联宽度，否则 width:0 的收起过渡会被内联样式压住
  p.style.width = '';
  p.style.flexBasis = '';
  $('#fpResizer').hidden = true;
  state.files.open = false;
}

function applyPanelWidth(w) {
  const p = $('#filePanel');
  p.style.setProperty('--fp-w', w + 'px');
  p.style.width = w + 'px';
  p.style.flexBasis = w + 'px';
}

export async function openFiles() {
  const s = sess();
  if (!s) { toast('请先连接一台服务器', 'warn'); return; }
  const p = $('#filePanel');
  p.classList.add('open');
  $('#fpResizer').hidden = false;
  applyPanelWidth(state.settings.filesWidth || 302);
  state.files.open = true;
  if (!dragBound) { bindDragDrop(); dragBound = true; }
  renderQueue();
  await load(s.cwd || '/');
}

/** 打开文件管理并定位到指定目录（状态栏「当前目录」右键用） */
export async function openAt(path) {
  const p = $('#filePanel');
  if (!p.classList.contains('open')) await openFiles();
  if (path) await load(path);
}

/**
 * 读取目录。
 * `owner` 语义：一次请求只属于发起它的那个会话。等待期间如果用户切换 / 断开了
 * 会话，这批结果必须丢弃并按新会话重读——否则面板会显示 A 的目录，而后续操作
 * 走的是 B（可能在另一台机器上删文件）。
 * `hop` 只是防止极端情况下「切换 → 重读 → 又切换」无限递归。
 */
async function load(path, hop = 0) {
  const s = sess();
  if (!s) { toast('会话已断开', 'warn'); return; }
  const owner = s.id;
  const mySeq = ++loadSeq;
  // 归属先落定：读取期间面板上的旧内容属于 owner，操作也应发给 owner，
  // 直到这批结果被丢弃并改读新会话为止。
  state.files.sid = owner;
  state.files.loading = true;
  renderLoading();
  try {
    const entries = await invoke('sftp_list', { sessionId: owner, path });
    if (mySeq !== loadSeq) return;
    const cur = sess();
    if (!cur || cur.id !== owner) {
      state.files.loading = false;
      if (cur && hop < 2) await load(cur.cwd || '/', hop + 1);
      else if (!cur) closeFiles();
      return;
    }
    state.files.sid = owner;
    state.files.path = path;
    state.files.entries = entries;
    render();
  } catch (e) {
    if (mySeq !== loadSeq) return;
    const cur = sess();
    if (!cur || cur.id !== owner) {
      state.files.loading = false;
      if (cur && hop < 2) await load(cur.cwd || '/', hop + 1);
      else if (!cur) closeFiles();
      return;
    }
    state.files.sid = owner;
    state.files.entries = [];
    render();
    toast(typeof e === 'string' ? e : e?.message || '读取目录失败', 'warn');
  } finally {
    if (mySeq === loadSeq) state.files.loading = false;
  }
}

let loadSeq = 0;

/**
 * 会话切换后让文件面板跟随：同一个面板不能继续显示上一台主机的目录，
 * 否则「刷新 / 删除」会用新连接去操作旧路径（多数情况下直接报错，或在另一台
 * 机器上删东西）。这里以面板内容所属会话为准，不做「当前活动会话」假设。
 */
export function syncFilesSession() {
  const p = $('#filePanel');
  if (!p.classList.contains('open')) return;
  const s = sess();
  if (!s) {
    closeFiles();
    toast('会话已断开，文件管理面板已关闭', 'warn', 3600);
    return;
  }
  if (state.files.sid === s.id) return;
  load(s.cwd || '/');
}

function renderLoading() {
  $('#fpList').innerHTML = '<div class="hint" style="padding:10px">读取中…</div>';
  $('#fpSub').textContent = `${sess()?.name || ''} · 读取中…`;
}

function render() {
  const s = panelSess() || sess();
  $('#fpSub').textContent = `${s ? s.name + ' · ' : ''}${state.files.path}`;
  // 面包屑
  const crumb = $('#fpCrumb');
  crumb.innerHTML = '';
  const parts = state.files.path.split('/').filter(Boolean);
  const mkCrumb = (label, path) => {
    const b = h('button', '', esc(label));
    b.addEventListener('click', () => load(path || '/'));
    return b;
  };
  crumb.appendChild(mkCrumb('/', '/'));
  let acc = '';
  parts.forEach((p) => {
    acc += '/' + p;
    crumb.appendChild(h('span', 'sep', '›'));
    crumb.appendChild(mkCrumb(p, acc));
  });

  const list = $('#fpList');
  if (!state.files.entries.length) {
    list.innerHTML = '<div class="hint" style="padding:10px">空目录</div>';
    return;
  }
  list.innerHTML = '';
  state.files.entries.forEach((e) => {
    const row = h('div', 'fp-row');
    row.innerHTML =
      `<span class="f-ico${e.is_dir ? ' dir' : ''}">${e.is_dir
        ? '<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 7.6a2 2 0 012-2h3.2l1.8 2.2h6a2 2 0 012 2v7.6a2 2 0 01-2 2H5.5a2 2 0 01-2-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none"><path d="M7 3.6h7l4 4.2v12.6H7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'}</span>` +
      `<span class="f-name">${esc(e.name)}</span>` +
      `<span class="f-meta">${e.is_dir ? '目录' : fmtSize(e.size)} · ${fmtTime(e.mtime)}</span>` +
      (e.is_dir ? '' : '<button class="f-dl" data-tip="下载"><svg viewBox="0 0 24 24" fill="none"><path d="M12 5v11M7.5 11.5L12 16l4.5-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>');
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.f-dl')) { download(e); return; }
      if (e.is_dir) load(e.path);
      else toast('双击行上方按钮可下载；目录可进入');
    });
    row.addEventListener('dblclick', () => { if (e.is_dir) load(e.path); });
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openCtx(ev.clientX, ev.clientY, [
        { title: e.name, sub: e.is_dir ? '目录' : fmtSize(e.size) + ' · ' + (fmtTime(e.mtime) || ''), icon: e.is_dir ? 'folder' : 'file' },
        ...(e.is_dir
          ? [{ label: '进入目录', icon: 'chevronRight', act: () => load(e.path) }]
          : [{ label: '下载到…', icon: 'download', act: () => download(e) }]),
        { sep: true },
        { label: '重命名', icon: 'pencil', act: () => renameModal(e) },
        { sep: true },
        { label: '删除', icon: 'trash', danger: true, act: () => removeEntry(e) }
      ]);
    });
    list.appendChild(row);
  });
}

/* ---------------- 工具栏 ---------------- */
export function initFiles() {
  $('#fpClose').addEventListener('click', closeFiles);
  initResizer();
  initTransferQueue();
  $('#fpUp').addEventListener('click', () => {
    const p = state.files.path.replace(/\/+$/, '');
    if (p && p !== '/') load(p.slice(0, p.lastIndexOf('/')) || '/');
  });
  $('#fpRefresh').addEventListener('click', () => load(state.files.path));
  $('#fpNewDir').addEventListener('click', async () => {
    const s = needPanelSess(); if (!s) return;
    import('./ui.js').then(({ openModal }) => {
      const mask = openModal(
        '<div class="field"><label>目录名</label><input id="ndName" placeholder="new-dir"/></div>' +
        '<div class="m-foot"><span class="spacer"></span><button class="btn" data-close>取消</button><button class="btn primary" id="ndOk">创建</button></div>',
        { title: '新建目录' }
      );
      mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
      mask.querySelector('#ndOk').addEventListener('click', async () => {
        const name = mask.querySelector('#ndName').value.trim();
        if (!name) return;
        try {
          await invoke('sftp_mkdir', { sessionId: s.id, path: joinPath(state.files.path, name) });
          invalidateDirCache();
          mask.close();
          load(state.files.path);
        } catch (e) { toast(typeof e === 'string' ? e : e?.message || '创建失败', 'warn'); }
      });
      setTimeout(() => mask.querySelector('#ndName').focus(), 50);
    });
  });
  $('#fpUpload').addEventListener('click', async () => {
    const s = needPanelSess(); if (!s) return;
    if (!IN_TAURI) { toast('浏览器演示模式不支持文件选择', 'warn'); return; }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const paths = await open({ multiple: true, title: '选择要上传的文件或目录' });
      if (paths) upload(paths);
    } catch (_) {}
  });

  // 文件列表空白处右键
  $('#fpList')?.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.fp-row')) return;
    e.preventDefault();
    openCtx(e.clientX, e.clientY, [
      { title: '当前目录', sub: state.files.path, icon: 'folder' },
      { label: '上传文件', icon: 'upload', act: () => $('#fpUpload').click() },
      { label: '新建目录', icon: 'folderPlus', act: () => $('#fpNewDir').click() },
      { sep: true },
      { label: '刷新', icon: 'refresh', kbd: 'F5', act: () => load(state.files.path) }
    ]);
  });
}

function joinPath(base, name) {
  return (base === '/' ? '' : base.replace(/\/+$/, '')) + '/' + name;
}

/* ---------------- 宽度拖拽 ---------------- */
const FP_MIN = 220, FP_MAX = 680, FP_DEFAULT = 302;

function initResizer() {
  const panel = $('#filePanel'), handle = $('#fpResizer');
  if (!panel || !handle) return;

  handle.addEventListener('pointerdown', (e) => {
    if (!panel.classList.contains('open')) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    panel.classList.add('resizing');
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.round(Math.min(FP_MAX, Math.max(FP_MIN, startW - (ev.clientX - startX))));
      applyPanelWidth(w);
    };
    const up = () => {
      handle.classList.remove('active');
      panel.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      state.settings.filesWidth = Math.round(panel.getBoundingClientRect().width);
      persistSoon();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  handle.addEventListener('dblclick', () => {
    applyPanelWidth(FP_DEFAULT);
    state.settings.filesWidth = FP_DEFAULT;
    persistSoon();
  });
}

/* ---------------- 传输队列 ----------------
   队列调度放在前端（串行执行，一条 SFTP 通道上更稳），后端只负责执行单个任务：
   进度 / 状态全部通过 sftp-progress 事件回传（running / paused / done / cancelled / error）。
   暂停、继续、取消按 transferId 直接作用到后端控制块。
   断点续传由后端按「已有字节数」自动判定，前端只负责在失败 / 取消后重新入队。
   ------------------------------------------- */
const queue = [];
let trSeq = 0;
let pausedAll = false;

function newTransferId() {
  trSeq += 1;
  return `tx-${Date.now().toString(36)}-${trSeq}`;
}

/** 传输归属会话：按 serverId 找在线会话（重连后会话 id 会变，不能钉死旧 id） */
function sessionFor(item) {
  const cands = state.sessions.filter((s) => s.serverId === item.serverId && s.status === 'open');
  return cands.find((s) => s.id === item.sessionId) || cands[0] || null;
}

export async function uploadTo(localPaths, remoteDir) {
  const s = needPanelSess(); if (!s) return;
  const dir = remoteDir || state.files.path;
  localPaths.forEach((lp) => {
    const name = String(lp).split(/[\\/]/).pop() || String(lp);
    queue.push({
      id: newTransferId(), kind: 'up', name, file: '',
      serverId: s.serverId, sessionId: s.id,
      localPath: lp, remoteDir: dir, remotePath: '', localTarget: '',
      status: 'queued', transferred: 0, total: 0, speed: 0, eta: null,
      resumedFrom: 0, error: '', el: null
    });
  });
  renderQueue();
  pumpQueue();
}

async function upload(localPaths) {
  return uploadTo(localPaths, state.files.path);
}

async function download(entry) {
  const s = needPanelSess(); if (!s) return;
  let target = null;
  if (IN_TAURI) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      target = await save({ defaultPath: entry.name, title: '保存到…' });
    } catch (_) {}
    if (!target) return;
  } else {
    target = 'C://Users//demo//Downloads//' + entry.name;
  }
  queue.push({
    id: newTransferId(), kind: 'down', name: entry.name, file: '',
    serverId: s.serverId, sessionId: s.id,
    localPath: '', remoteDir: state.files.path, remotePath: entry.path, localTarget: target,
    status: 'queued', transferred: 0, total: entry.size || 0, speed: 0, eta: null,
    resumedFrom: 0, error: '', el: null
  });
  renderQueue();
  pumpQueue();
}

/** 串行推进：同时只跑一个任务（暂停全部时不启动新任务） */
function pumpQueue() {
  if (pausedAll) return;
  if (queue.some((i) => i.status === 'running' || i.status === 'cancelling')) return;
  const next = queue.find((i) => i.status === 'queued');
  if (next) startItem(next);
}

async function startItem(item) {
  const s = sessionFor(item);
  if (!s) {
    item.status = 'failed';
    item.error = '所属主机会话已断开';
    updateRow(item);
    pumpQueue();
    return;
  }
  item.sessionId = s.id;
  item.status = 'running';
  item.error = '';
  item.speed = 0;
  item.eta = null;
  item.transferred = 0;
  item.resumedFrom = 0;
  item.__lastT = performance.now();
  item.__lastB = 0;
  updateRow(item);

  const isUp = item.kind === 'up';
  try {
    await invoke(isUp ? 'sftp_start_upload' : 'sftp_start_download', isUp
      ? { sessionId: s.id, localPath: item.localPath, remoteDir: item.remoteDir, transferId: item.id }
      : { sessionId: s.id, remotePath: item.remotePath, localPath: item.localTarget, transferId: item.id });
  } catch (e) {
    item.status = 'failed';
    item.error = errText(e);
    updateRow(item);
    pumpQueue();
  }
}

function errText(e) {
  return (typeof e === 'string' ? e : e?.message || '传输失败').replace(/\s*\n\s*/g, ' ');
}

/** 传输完成 / 失败后的收尾 */
function settle(item, status, error) {
  item.status = status;
  if (status === 'done') {
    item.transferred = item.total || item.transferred;
    item.speed = 0;
    item.eta = 0;
  } else {
    item.speed = 0;
    item.eta = null;
  }
  if (error) item.error = error;
  updateRow(item);
  if (status === 'done') {
    invalidateDirCache();
    if (item.kind === 'up' && item.remoteDir === state.files.path && $('#filePanel').classList.contains('open')) {
      load(state.files.path);
    }
    if (item.kind === 'down') toast(`已保存到 ${item.localTarget}`, 'ok', 4000);
  }
  pumpQueue();
}

/* ---------------- 传输行渲染 ---------------- */
const TR_ICON = {
  pause: '<path d="M9 5.5v13M15 5.5v13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  play: '<path d="M8 5.6l10 6.4-10 6.4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  cancel: '<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  retry: '<path d="M20 12a8 8 0 10-2.6 5.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M20 5.6V12h-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  remove: '<path d="M5 8h14M9.5 4.8h5M7 8l.8 10.4a1.6 1.6 0 001.6 1.5h5.2a1.6 1.6 0 001.6-1.5L17 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
};

function trBtn(act, icon, tip, cls = '') {
  return `<button class="tr-btn${cls ? ' ' + cls : ''}" data-act="${act}" data-tip="${tip}">` +
    `<svg viewBox="0 0 24 24" fill="none">${TR_ICON[icon]}</svg></button>`;
}

function renderQueue() {
  const list = $('#trList');
  if (!list) return;
  queue.forEach((item) => {
    if (!item.el || !item.el.isConnected) {
      const el = h('div', 'tr-row');
      el.dataset.id = item.id;
      el.innerHTML =
        '<div class="tr-top"><span class="tr-dir"></span><span class="tr-name"></span><span class="tr-pct">0%</span></div>' +
        '<div class="tr-bar"><i style="width:0%"></i></div>' +
        '<div class="tr-meta"><span class="tr-stat"></span><span class="spacer"></span><span class="tr-acts"></span></div>';
      el.querySelector('.tr-acts').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-act]');
        if (!b) return;
        ev.stopPropagation();
        onTrAction(item, b.dataset.act);
      });
      item.el = el;
      list.appendChild(el);
    }
    updateRow(item);
  });
  // 清掉已从队列移除的行
  [...list.children].forEach((el) => {
    if (!queue.some((i) => i.id === el.dataset.id)) el.remove();
  });
  const count = $('#trCount');
  if (count) count.textContent = String(queue.filter((i) => i.status !== 'done' && i.status !== 'failed' && i.status !== 'cancelled').length);
  const box = $('#fpTransfers');
  if (box) box.classList.toggle('has-items', queue.length > 0);
}

function updateRow(item) {
  const el = item.el;
  if (!el || !el.isConnected) return;
  el.className = `tr-row ${item.status}`;
  const pct = item.total > 0 ? Math.min(100, Math.floor((item.transferred / item.total) * 100)) : 0;
  el.querySelector('.tr-dir').textContent = item.kind === 'up' ? '↑ 上传' : '↓ 下载';
  const nameEl = el.querySelector('.tr-name');
  const shown = item.file && item.file !== item.name ? `${item.name} / ${item.file}` : item.name;
  if (nameEl.textContent !== shown) nameEl.textContent = shown;
  const pctEl = el.querySelector('.tr-pct');
  pctEl.textContent = item.status === 'queued' ? '排队' : `${pct}%`;
  el.querySelector('.tr-bar > i').style.width = `${pct}%`;

  const stat = el.querySelector('.tr-stat');
  const size = `${fmtSize(item.transferred || 0)} / ${fmtSize(item.total || 0)}`;
  let text;
  switch (item.status) {
    case 'queued': text = `等待开始 · ${fmtSize(item.total || 0)}`; break;
    case 'running': text = `${size} · ${fmtSpeed(item.speed)} · 剩余 ${fmtEta(item.eta, item.total, item.transferred, item.speed)}`; break;
    case 'cancelling': text = '正在取消…'; break;
    case 'paused': text = `已暂停 · ${size}`; break;
    case 'done': text = `完成 · ${fmtSize(item.total || item.transferred)}`; break;
    case 'cancelled': text = `已取消 · ${size}`; break;
    case 'failed': text = `失败：${item.error || '未知错误'}`; break;
    default: text = '';
  }
  if (item.resumedFrom > 0 && item.status !== 'failed') text += ` · 续传自 ${fmtSize(item.resumedFrom)}`;
  stat.textContent = text;
  stat.classList.toggle('err', item.status === 'failed');

  // 按钮只在「状态种类」变化时重建：
  // 进度事件每 120ms 触发一次 updateRow，若每次都比对 innerHTML 重建，
  // 悬停中的按钮会被反复替换（:hover 重置 + 气泡重弹）→ 视觉上闪烁。
  // 用状态键判断，运行中的按钮节点全程稳定。
  const acts = el.querySelector('.tr-acts');
  let html = '';
  if (item.status === 'running') html = trBtn('pause', 'pause', '暂停') + trBtn('cancel', 'cancel', '取消');
  else if (item.status === 'paused') html = trBtn('resume', 'play', '继续') + trBtn('cancel', 'cancel', '取消');
  else if (item.status === 'queued' || item.status === 'cancelling') html = trBtn('cancel', 'cancel', '取消');
  else if (item.status === 'failed' || item.status === 'cancelled') html = trBtn('retry', 'retry', '重试（断点续传）') + trBtn('remove', 'remove', '从队列移除');
  else if (item.status === 'done') html = trBtn('remove', 'remove', '从队列移除');
  if (acts.dataset.acts !== item.status) {
    acts.dataset.acts = item.status;
    // 按钮即将被替换（如传输刚好完成）：先收起气泡，否则它会钉在已移除的元素上不消失
    hideTooltip();
    acts.innerHTML = html;
  }
}

async function onTrAction(item, act) {
  if (act === 'pause') {
    item.status = 'paused';
    updateRow(item);
    try { await invoke('sftp_pause_transfer', { transferId: item.id }); } catch (_) {}
    return;
  }
  if (act === 'resume') {
    item.__autoPaused = false;
    item.status = 'running';
    item.__lastT = performance.now();
    item.__lastB = item.transferred;
    updateRow(item);
    try { await invoke('sftp_resume_transfer', { transferId: item.id }); } catch (_) {}
    pumpQueue();
    return;
  }
  if (act === 'cancel') {
    item.status = 'cancelling';
    updateRow(item);
    try { await invoke('sftp_cancel_transfer', { transferId: item.id }); } catch (_) {}
    // 后端会在下一个检查点退出并回 cancelled 事件；兜底 6s 后自行判定
    setTimeout(() => {
      if (item.status === 'cancelling') settle(item, 'cancelled');
    }, 6000);
    if (pausedAll) pumpQueue();
    return;
  }
  if (act === 'retry') {
    item.status = 'queued';
    item.error = '';
    item.speed = 0;
    item.eta = null;
    item.transferred = 0;
    updateRow(item);
    pumpQueue();
    return;
  }
  if (act === 'remove') {
    const i = queue.indexOf(item);
    if (i >= 0) queue.splice(i, 1);
    renderQueue();
  }
}

/** 后端 sftp-progress 事件入口 */
export function onTransferProgress(p) {
  if (!p || !p.transferId) return;
  const item = queue.find((i) => i.id === p.transferId);
  if (!item) return;
  if (p.name) item.file = p.name;
  if (Number.isFinite(p.total) && p.total > 0) item.total = p.total;

  if (p.state === 'done') { settle(item, 'done'); return; }
  if (p.state === 'cancelled') { settle(item, 'cancelled'); return; }
  if (p.state === 'error') { settle(item, 'failed', p.error || '传输失败'); return; }
  if (p.state === 'paused') { item.status = 'paused'; updateRow(item); return; }

  if (Number.isFinite(p.transferred)) {
    if (p.resumedFrom) item.resumedFrom = p.resumedFrom;
    const now = performance.now();
    const dt = (now - (item.__lastT || now)) / 1000;
    const db = p.transferred - (item.__lastB || 0);
    if (dt >= 0.25 && db >= 0) {
      const inst = db / dt;
      item.speed = item.speed ? item.speed * 0.6 + inst * 0.4 : inst;
      item.__lastT = now;
      item.__lastB = p.transferred;
    }
    item.transferred = p.transferred;
    if (item.status === 'running') updateRow(item);
  }
}

/* 速率 / 剩余时间格式化 */
function fmtSpeed(bps) {
  const v = Number(bps) || 0;
  if (v <= 0) return '计算中…';
  if (v < 1024) return `${v.toFixed(0)} B/s`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB/s`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB/s`;
}

function fmtEta(eta, total, done, speed) {
  let sec = eta;
  if ((!Number.isFinite(sec) || sec === null) && speed > 0 && total > done) sec = (total - done) / speed;
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  sec = Math.ceil(sec);
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

/** 暂停全部 / 继续全部 / 清除已完成 */
export function initTransferQueue() {
  const pauseAll = $('#trPauseAll');
  const clear = $('#trClear');
  if (pauseAll) {
    pauseAll.addEventListener('click', async () => {
      pausedAll = !pausedAll;
      pauseAll.dataset.tip = pausedAll ? '继续全部' : '暂停全部';
      pauseAll.classList.toggle('on', pausedAll);
      // 图标跟随状态切换：暂停中显示「继续」（播放）图标，否则显示「暂停」图标
      pauseAll.innerHTML = `<svg viewBox="0 0 24 24" fill="none">${TR_ICON[pausedAll ? 'play' : 'pause']}</svg>`;
      for (const item of queue) {
        if (pausedAll && item.status === 'running') {
          item.__autoPaused = true;
          item.status = 'paused';
          updateRow(item);
          try { await invoke('sftp_pause_transfer', { transferId: item.id }); } catch (_) {}
        } else if (!pausedAll && item.status === 'paused' && item.__autoPaused) {
          item.__autoPaused = false;
          item.status = 'running';
          item.__lastT = performance.now();
          item.__lastB = item.transferred;
          updateRow(item);
          try { await invoke('sftp_resume_transfer', { transferId: item.id }); } catch (_) {}
        }
      }
      if (!pausedAll) pumpQueue();
    });
  }
  if (clear) {
    clear.addEventListener('click', () => {
      for (let i = queue.length - 1; i >= 0; i--) {
        const st = queue[i].status;
        if (st === 'done' || st === 'failed' || st === 'cancelled') queue.splice(i, 1);
      }
      renderQueue();
    });
  }
}

async function renameModal(entry) {
  const s = needPanelSess(); if (!s) return;
  import('./ui.js').then(({ openModal }) => {
    const mask = openModal(
      '<div class="field"><label>新名称</label><input id="rnName" value="' + esc(entry.name) + '"/></div>' +
      '<div class="m-foot"><span class="spacer"></span><button class="btn" data-close>取消</button><button class="btn primary" id="rnOk">保存</button></div>',
      { title: '重命名' }
    );
    mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
    mask.querySelector('#rnOk').addEventListener('click', async () => {
      const name = mask.querySelector('#rnName').value.trim();
      if (!name || name === entry.name) { mask.close(); return; }
      try {
        await invoke('sftp_rename', { sessionId: s.id, from: entry.path, to: joinPath(state.files.path, name) });
        invalidateDirCache();
        mask.close();
        load(state.files.path);
      } catch (e) { toast(typeof e === 'string' ? e : e?.message || '重命名失败', 'warn'); }
    });
  });
}

async function removeEntry(entry) {
  const s = needPanelSess(); if (!s) return;
  import('./ui.js').then(({ openModal }) => {
    const mask = openModal(
      `<div class="hint" style="font-size:12px;line-height:1.8">确认删除远程${entry.is_dir ? '目录' : '文件'} <b>${esc(entry.name)}</b>${entry.is_dir ? '（含全部内容）' : ''}？此操作不可撤销。</div>` +
      '<div class="m-foot"><span class="spacer"></span><button class="btn" data-close>取消</button><button class="btn primary" id="rmOk" style="background:var(--term-red);border-color:var(--term-red)">删除</button></div>',
      { title: '删除' }
    );
    mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
    mask.querySelector('#rmOk').addEventListener('click', async () => {
      try {
        await invoke('sftp_remove', { sessionId: s.id, path: entry.path, isDir: entry.is_dir });
        invalidateDirCache();
        mask.close();
        load(state.files.path);
        toast('已删除', 'ok');
      } catch (e) { toast(typeof e === 'string' ? e : e?.message || '删除失败', 'warn'); }
    });
  });
}

/* ---------------- 拖拽上传（Tauri webview 级事件） ---------------- */
function bindDragDrop() {
  if (!IN_TAURI) return;
  import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
    const drop = $('#fpDrop');
    await getCurrentWebview().onDragDropEvent((event) => {
      const type = event.payload.type;
      if (!state.files.open) return;
      if (type === 'over') {
        drop.hidden = false;
        drop.classList.add('show');
      } else if (type === 'drop') {
        drop.hidden = true;
        drop.classList.remove('show');
        const paths = event.payload.paths || [];
        if (paths.length) upload(paths);
      } else if (type === 'leave' || type === 'cancel') {
        drop.hidden = true;
        drop.classList.remove('show');
      }
    });
  });
}
