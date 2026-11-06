/**
 * 会话生命周期 + 会话管理栏（缩略图列表）
 */
import { state, byId, byServer, nextIndex, sessionLabel, getServer, addHistory } from './state.js';
import { invoke } from './api.js';
import { createHost, attachHost } from './term.js';
import { $, h, esc, toast, openCtx, menuIcon } from './ui.js';
import { feedMulti, renderFilterTabs, attachMultiView, dropSession } from './multi.js';
import { renderStatus, renderPalette, refreshServerFoot, toggleCol, switchMode } from './workspace.js';
import { noteInput, noteOutput, setCwd, noteCommand, stripAnsi } from './cwd.js';

let seq = 0;

/* ---------------- 断线自动重连 ----------------
   连接意外断开（非用户主动关闭）时按指数退避尝试重连：
   重连成功后恢复原工作目录，并探测 tmux / screen 会话给出恢复提示。
   会话对象与 xterm 宿主始终复用，终端历史不会因为重连被清空。
   ------------------------------------------- */
const RECONNECT_MAX = 6;
const RECONNECT_DELAYS = [800, 1600, 3000, 5000, 8000, 12000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusText(sess) {
  if (sess.status === 'open') return sess.user;
  if (sess.status === 'connecting') return '连接中…';
  if (sess.status === 'reconnecting') return `重连中 ${sess.reconnectAttempt || 1}/${RECONNECT_MAX}…`;
  return '已断开';
}

function writeLine(sess, text) {
  try { sess.host?.term.write(`${text}\x1b[0m\r\n`); } catch (_) {}
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 每次重连是否需要继续尝试：用户关掉卡片 / 会话被移除即停止 */
function reconnectAlive(sess) {
  return state.sessions.includes(sess) && !sess.stopReconnect;
}

export async function createSession(server, { silent = false } = {}) {
  if (!server) return null;
  const pendingId = 'pending-' + (++seq) + '-' + Date.now();
  const sess = {
    id: pendingId,
    serverId: server.id,
    index: nextIndex(server.id),
    name: server.name,
    ip: server.ip,
    user: server.user,
    port: server.port,
    status: 'connecting',
    cwd: '/',
    unread: false,
    cardEl: null,
    pvEl: null,
    pv: { lines: [], dirty: true },
    lastCmd: '',
    __pvBuf: '',
    aborted: false,
    disposed: false,
    host: null
  };
  state.sessions.push(sess);

  try {
    sess.host = createHost({
      onData: (d) => onTermInput(sess, d),
      onResize: (cols, rows) => {
        if (sess.status === 'open') invoke('ssh_resize', { sessionId: sess.id, cols, rows }).catch(() => {});
      }
    });
    sess.host.term.__cwdHandler = (cwd) => { setCwd(sess, cwd, 'osc7'); };
  } catch (e) {
    // 配置损坏时（例如 settings.fontSize 被手改成非数字）new Terminal() 会抛异常。
    // 以前这一步在 try 之外：卡片已经入列，于是永久停在「连接中…」，重试也无效。
    const i = state.sessions.indexOf(sess);
    if (i >= 0) state.sessions.splice(i, 1);
    renderSessionList();
    refreshServerFoot();
    toast(
      `无法创建终端：${e?.message || e}（终端设置可能已损坏，可在设置中恢复默认）`,
      'warn',
      5200
    );
    return null;
  }

  renderSessionList();
  if (!silent) toast(`正在连接 ${server.name} (${server.ip}) …`);

  try {
    const info = await invoke('ssh_connect', { server, cols: sess.host.term.cols, rows: sess.host.term.rows });
    // 握手期间用户已经关掉了这个会话：后端连接其实已经建立，必须回收，
    // 否则服务器上会残留一个 shell（旧的 ssh_close(pendingId) 必然失败）。
    if (sess.aborted || !state.sessions.includes(sess)) {
      invoke('ssh_close', { sessionId: info.id }).catch(() => {});
      discardEarly(info.id);
      disposeHost(sess);
      return null;
    }
    sess.id = info.id;
    sess.status = 'open';
    sess.name = info.name || sess.name;
    try { sess.host.term.write(`\x1b[90m ── ${info.name} · ${info.ip}:${info.port} · 已连接 ──\x1b[0m\r\n\r\n`); } catch (_) {}
    // 回放握手期间先到的 banner / 首个提示符
    flushEarly(sess);
  } catch (e) {
    if (sess.aborted || !state.sessions.includes(sess)) { disposeHost(sess); return null; }
    sess.status = 'closed';
    const msg = typeof e === 'string' ? e : e?.message || '未知错误';
    // 主机密钥校验失败等信息是多行的：终端要按 CRLF 写，提示条压成一行
    try { sess.host.term.write(`\x1b[31m ✕ 连接失败：${String(msg).replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`); } catch (_) {}
    toast(`连接 ${server.name} 失败：${String(msg).replace(/\s*\n\s*/g, ' ')}`, 'warn', 6000);
  }

  if (sess.aborted || !state.sessions.includes(sess)) { disposeHost(sess); return null; }
  refreshSessionCards();
  refreshServerFoot();
  activate(sess.id);
  return sess;
}

function disposeHost(sess) {
  if (sess.disposed) return;
  sess.disposed = true;
  try { sess.host?.dispose(); } catch (_) {}
  sess.host = null;
}

/* ---------------- 连接窗口期的早期事件 ----------------
   ssh_connect 返回真实会话 id 之前，远端的登录横幅 / 首个提示符可能已经
   通过 ssh-data 事件到达。此时 byId() 还查不到会话，旧实现会直接丢弃，
   表现为「首屏内容丢失」。这里先缓存，拿到 id 后立刻按原顺序回放。
   ---------------------------------------------------------- */
const early = new Map();      // backend sessionId -> { data: [], cwd, closed, bytes, at }
const EARLY_TTL = 20000;
const EARLY_MAX_ENTRIES = 64;
const EARLY_MAX_BYTES = 2 * 1024 * 1024;
let earlyBytes = 0;

function dropEarlyEntry(id) {
  const e = early.get(id);
  if (!e) return;
  earlyBytes -= e.bytes;
  early.delete(id);
}

function pruneEarly() {
  const now = Date.now();
  for (const [id, e] of early) {
    if (now - e.at > EARLY_TTL) dropEarlyEntry(id);
  }
  while (early.size > EARLY_MAX_ENTRIES || earlyBytes > EARLY_MAX_BYTES) {
    const oldest = early.keys().next().value;
    if (oldest === undefined) break;
    dropEarlyEntry(oldest);
  }
}

function stashEarly(id, patch = {}) {
  if (!id) return;
  pruneEarly();
  let e = early.get(id);
  if (!e) {
    e = { data: [], cwd: null, closed: null, bytes: 0, at: Date.now() };
    early.set(id, e);
  }
  if (patch.data) { e.data.push(patch.data); e.bytes += patch.data.length; earlyBytes += patch.data.length; }
  if (patch.cwd != null) e.cwd = patch.cwd;
  if (patch.closed !== undefined) e.closed = patch.closed;
  // 单条会话缓冲上限：异常刷屏时不至于吃满内存
  if (e.bytes > EARLY_MAX_BYTES / 4) { e.data = []; earlyBytes -= e.bytes; e.bytes = 0; }
}

function discardEarly(id) {
  dropEarlyEntry(id);
}

function flushEarly(sess) {
  const e = early.get(sess.id);
  if (!e) return;
  dropEarlyEntry(sess.id);
  if (e.cwd) setCwd(sess, e.cwd, 'event');
  e.data.forEach((d) => applyData(sess, d));
  if (e.closed !== null) handleClosed(sess, e.closed);
}

/** 把一帧 PTY 输出落到终端 / cwd / 预览 / 聚合视图 */
function applyData(sess, data) {
  try { sess.host?.term.write(data); } catch (_) {}
  // 先解析提示符里的目录，再写入聚合时间线：保证该行前缀用的是最新 cwd
  noteOutput(sess, data);
  notePreview(sess, data);
  feedMulti(sess, data);
  if (state.mode === 'workbench' && sess.id !== state.activeId) markUnread(sess);
}

function handleClosed(sess, reason) {
  if (sess.status !== 'open') return;
  sess.status = 'closed';
  try { sess.host?.term.write(`\r\n\x1b[31m ✕ ${reason || '连接已断开'}\x1b[0m\r\n`); } catch (_) {}
  dropSession(sess);
  refreshSessionCards();
  if (sess.id === state.activeId) renderStatus();
  toast(`${sess.name}[${sess.index}] 连接已断开：${reason || '未知原因'}`, 'warn', 4200);

  // 用户主动断开不会走到这里（closeSession 先把状态置为 closed），
  // 所以这就是「意外掉线」，按设置尝试自动重连。
  if (state.settings.autoReconnect !== false) startReconnect(sess, reason);
  else refreshServerFoot();
}

/**
 * 自动重连：指数退避重试，成功后恢复工作目录 + 探测 tmux / screen。
 * 任何时刻用户关闭卡片都会把 stopReconnect 置真，循环在下一个检查点退出。
 */
async function startReconnect(sess, reason) {
  if (sess.reconnecting || !reconnectAlive(sess)) return;
  const server = getServer(sess.serverId);
  if (!server) {
    toast(`${sess.name} 的主机记录已被删除，无法自动重连`, 'warn', 5000);
    refreshServerFoot();
    return;
  }
  sess.reconnecting = true;
  sess.status = 'reconnecting';
  sess.reconnectAttempt = 0;
  const cwd = sess.cwd || '/';
  const label = `${sess.name}[${sess.index}]`;
  writeLine(sess, `\x1b[33m ↻ 连接中断（${reason || '未知原因'}），开始自动重连…\x1b[0m`);
  refreshSessionCards();
  refreshServerFoot();
  renderStatus();

  let lastErr = '';
  for (let attempt = 1; attempt <= RECONNECT_MAX; attempt += 1) {
    sess.reconnectAttempt = attempt;
    if (!reconnectAlive(sess)) { sess.reconnecting = false; return; }
    await sleep(RECONNECT_DELAYS[Math.min(attempt - 1, RECONNECT_DELAYS.length - 1)]);
    if (!reconnectAlive(sess)) { sess.reconnecting = false; return; }

    writeLine(sess, `\x1b[90m ↻ 第 ${attempt}/${RECONNECT_MAX} 次重连…\x1b[0m`);
    refreshSessionCards();
    try {
      const term = sess.host?.term;
      const info = await invoke('ssh_connect', {
        server,
        cols: term?.cols || 80,
        rows: term?.rows || 24
      });
      if (!reconnectAlive(sess)) {
        invoke('ssh_close', { sessionId: info.id }).catch(() => {});
        sess.reconnecting = false;
        return;
      }
      adoptSession(sess, info);
      writeLine(sess, `\x1b[32m ✓ 已重新连接（第 ${attempt} 次尝试）\x1b[0m`);
      toast(`${label} 已自动重连`, 'ok', 3200);
      await restoreAfterReconnect(sess, cwd);
      sess.reconnecting = false;
      refreshSessionCards();
      refreshServerFoot();
      renderStatus();
      import('./files.js').then((m) => m.syncFilesSession?.()).catch(() => {});
      return;
    } catch (e) {
      lastErr = String(typeof e === 'string' ? e : e?.message || e || '未知错误').replace(/\s*\n\s*/g, ' ');
      writeLine(sess, `\x1b[31m ↻ 重连失败：${lastErr}\x1b[0m`);
    }
  }

  if (!reconnectAlive(sess)) { sess.reconnecting = false; return; }
  sess.reconnecting = false;
  sess.status = 'closed';
  writeLine(sess, `\x1b[31m ✕ 自动重连失败（已重试 ${RECONNECT_MAX} 次）：${lastErr}\x1b[0m`);
  writeLine(sess, '\x1b[90m   可在卡片上双击重试，或检查网络 / 代理后重新连接\x1b[0m');
  toast(`${label} 自动重连失败：${lastErr}`, 'warn', 6000);
  refreshSessionCards();
  refreshServerFoot();
  renderStatus();
}

/** 接管新会话 id：卡片 / 活动会话 / 多控焦点 / 文件面板都要跟着换 */
function adoptSession(sess, info) {
  const oldId = sess.id;
  sess.id = info.id;
  sess.status = 'open';
  sess.reconnectedAt = Date.now();
  if (state.activeId === oldId) state.activeId = sess.id;
  if (state.multiFocus === oldId) state.multiFocus = sess.id;
  if (state.files.sid === oldId) state.files.sid = sess.id;
  // 握手期间先到的 banner / 提示符按新 id 缓存在 early 里，这里回放
  flushEarly(sess);
}

/** 重连后恢复现场：切回原目录 → 探测 tmux / screen */
async function restoreAfterReconnect(sess, cwd) {
  if (state.settings.restoreCwd !== false && cwd && cwd !== '/') {
    setCwd(sess, cwd, 'restore');
    writeLine(sess, `\x1b[90m ── 恢复工作目录：${cwd} ──\x1b[0m`);
    invoke('ssh_write', { sessionId: sess.id, data: `cd ${shQuote(cwd)}\r` }).catch(() => {});
  }
  await hintMultiplexer(sess);
}

/**
 * tmux / screen 集成提示：断线本身无法保住远端进程，
 * 但用户若在 tmux / screen 里工作，重连后只需 attach 即可回到原来的现场。
 */
async function hintMultiplexer(sess) {
  if (state.settings.reconnectHint === false) return;
  let out = '';
  try {
    out = await invoke('ssh_exec_quiet', {
      sessionId: sess.id,
      cmd: 'tmux ls 2>/dev/null; screen -ls 2>/dev/null; true'
    });
  } catch (_) {
    return;
  }
  if (!out || !out.trim()) return;
  const tmux = [];
  const screen = [];
  for (const raw of String(out).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^([^:]+):\s*\d+\s+windows?/.exec(line);
    if (m) { tmux.push(m[1].trim()); continue; }
    m = /^(\d+\.[^\s]+)\s+\(([^)]*)\)/.exec(line);
    if (m) screen.push(m[1]);
  }
  if (tmux.length) {
    const names = tmux.slice(0, 4).join('、') + (tmux.length > 4 ? ' 等' : '');
    writeLine(sess, `\x1b[36m ℹ 检测到 tmux 会话：${names}\x1b[0m`);
    writeLine(sess, `\x1b[36m   执行 tmux attach -t ${tmux[0]} 可回到断线前的现场（Ctrl-b d 脱离）\x1b[0m`);
    toast(`检测到 tmux 会话（${tmux[0]}），可 attach 恢复现场`, 'ok', 5200);
  } else if (screen.length) {
    writeLine(sess, `\x1b[36m ℹ 检测到 screen 会话：${screen.slice(0, 4).join('、')}\x1b[0m`);
    writeLine(sess, `\x1b[36m   执行 screen -r ${screen[0]} 可回到断线前的现场（Ctrl-a d 脱离）\x1b[0m`);
    toast(`检测到 screen 会话（${screen[0]}），可 screen -r 恢复现场`, 'ok', 5200);
  }
}

/* 后端事件入口：查不到会话时先缓存，避免连接窗口期的首屏内容丢失 */
export function onSessionData(id, data) {
  const s = byId(id);
  if (s) applyData(s, data);
  else stashEarly(id, { data });
}

export function onSessionCwd(id, cwd) {
  const s = byId(id);
  if (s) setCwd(s, cwd, 'event');
  else stashEarly(id, { cwd });
}

export function onSessionClosed(id, reason) {
  const s = byId(id);
  if (s) handleClosed(s, reason);
  else stashEarly(id, { closed: reason || '' });
}

/** 键盘输入 → PTY；回车时以终端缓冲区里的真实行为准重建历史（XShell 式） */
function onTermInput(sess, d) {
  if (sess.status !== 'open') return;
  if (d === '\r' || d === '\n') {
    // 必须在发送回车「之前」读：此刻屏幕上的行 = 提示符 + 用户真正执行的命令。
    // 这条路能拿到 Tab 补全 / ↑↓ 历史 / 光标编辑后的最终文本，
    // 而本地击键流只有补全前的前缀（旧的流解析正是「显示错乱」的来源）。
    const finalLine = readTermCommand(sess, sess.__inputLine || '');
    invoke('ssh_write', { sessionId: sess.id, data: d }).catch(() => {});
    sess.__inputLine = '';
    sess.__inputTainted = false;
    if (finalLine) {
      noteCommand(sess, finalLine);     // 预测 cwd + 记录 lastCmd（卡片顶部「最新命令」）
      pushHistory(finalLine);
      if (sess.pv) sess.pv.dirty = true;
    }
    return;
  }
  invoke('ssh_write', { sessionId: sess.id, data: d }).catch(() => {});
  // cwd 预测对每个会话都生效（多控里非活动终端、直接敲键盘的 cd 也要跟得上）
  noteInput(sess, d);
}

/**
 * 读取终端当前输入行（光标所在行，含软换行）的纯文本。
 * 返回「提示符 + 命令行」整串，交由 commandFromLine() 去掉提示符。
 */
function readTermCommand(sess, local) {
  const term = sess.host?.term;
  if (!term) return String(local || '').trim();
  let text = '';
  try {
    const buf = term.buffer.active;
    if (!buf || buf.type !== 'normal') return String(local || '').trim();
    let row = buf.baseY + buf.cursorY;
    let line = buf.getLine(row);
    if (!line) return String(local || '').trim();
    text = line.translateToString(true);
    // 长命令会折行：向上收集所有 isWrapped 的续行
    let guard = 0;
    while (line.isWrapped && row > 0 && guard++ < 8) {
      row -= 1;
      line = buf.getLine(row);
      if (!line) break;
      text = line.translateToString(false) + text;
    }
  } catch (_) {
    return String(local || '').trim();
  }
  return commandFromLine(text, local);
}

/** 从「提示符 + 命令行」里剥离提示符，得到用户实际执行的完整命令 */
function commandFromLine(text, local) {
  const t = String(text || '').replace(/\s+$/, '');
  const typed = String(local || '').trim();
  // 优先用本地已键入的前缀定位命令起点：终端回显里的补全部分会被完整保留
  if (typed) {
    const i = t.lastIndexOf(typed);
    if (i >= 0) return t.slice(i).trim();
  }
  const m = ECHO_CMD.exec(t);
  if (m) return m[1].trim();
  // 认不出提示符时：有本地记录就退回本地记录，否则宁可不记（避免把横幅当命令）
  return typed;
}

export function pushHistory(line) {
  // 去重 + 只保留最近 20 条 + 持久化，统一由 state.addHistory 处理
  addHistory(line);
  renderPalette();
}

export async function closeSession(sess, { quiet = false } = {}) {
  if (!sess) return;
  if (sess.status === 'connecting') {
    // 还在握手中：后端此刻没有真实会话 id，ssh_close 无从下手。
    // 标记 aborted，等 ssh_connect 返回后由 createSession 回收那条连接。
    sess.aborted = true;
    sess.status = 'closed';
    toast(`已取消连接 ${sess.name}`, 'warn', 2600);
    quiet = true;
  } else if (sess.status === 'open') {
    try { await invoke('ssh_close', { sessionId: sess.id }); } catch (_) {}
    sess.status = 'closed';
  } else {
    // 重连中 / 已断开：停掉重连循环，不再新建连接
    sess.stopReconnect = true;
    sess.reconnecting = false;
    sess.status = 'closed';
  }
  const wasActive = state.activeId === sess.id;
  state.sessions = state.sessions.filter((x) => x !== sess);
  disposeHost(sess);
  if (wasActive) {
    const next = state.sessions.find((s) => s.status === 'open');
    state.activeId = null;
    if (next) activate(next.id);
    else renderMainVisibility();
  }
  renderSessionList();
  renderStatus();
  renderFilterTabs();
  refreshServerFoot();
  import('./files.js').then((m) => m.syncFilesSession?.()).catch(() => {});
  if (!quiet) toast(`已断开 ${sess.name}[${sess.index}]`);
}

export function activate(id) {
  const s = byId(id);
  if (!s) return;
  s.unread = false;
  state.activeId = id;
  // renderMainVisibility 内部已把正确的宿主挂到 #termWork（attachHost 会互斥）
  renderMainVisibility();
  // 增量刷新卡片状态即可：全量重建会销毁所有 canvas，缩略图集体变黑闪一下
  refreshSessionCards();
  renderStatus();
  import('./files.js').then((m) => m.syncFilesSession?.()).catch(() => {});
  setTimeout(() => { try { s.host.term.focus(); } catch (_) {} }, 30);
}

/** 只更新已有卡片的状态（active / live / 未读 / 连接状态文案），不重建 DOM 与 canvas */
export function refreshSessionCards() {
  if (state.mode === 'multi') return;
  state.sessions.forEach((s) => {
    const card = s.cardEl;
    if (!card || !card.isConnected) return;
    card.classList.toggle('active', s.id === state.activeId);
    card.classList.toggle('is-live', s.status === 'open');
    const name = card.querySelector('.sess-name');
    if (name) {
      const dot = name.querySelector('.unread');
      if (s.unread && !dot) name.insertAdjacentHTML('beforeend', '<span class="unread" data-tip="有新输出"></span>');
      else if (!s.unread && dot) dot.remove();
    }
    const sub = card.querySelector('.sess-sub');
    if (sub) {
      sub.textContent = `${s.ip} · ${statusText(s)}`;
    }
    if (s.pv && s.pv.dirty) paintPreview(s);
  });
  $('#sessionsCount').textContent = String(state.sessions.length);
}

/** 根据 模式/活动会话 决定主区域显示内容 */
export function renderMainVisibility() {
  const empty = $('#termEmpty'), work = $('#termWork'), multi = $('#termMulti');
  const hasSessions = state.sessions.length > 0;
  empty.hidden = hasSessions;
  if (!hasSessions) { work.hidden = true; multi.hidden = true; return; }

  // 多控聚合视图（未被交互命令聚焦时）
  if (state.mode === 'multi' && !state.multiFocus) {
    work.hidden = true;
    multi.hidden = false;
    renderFilterTabs();
    attachMultiView();
    return;
  }

  // 单会话视图：工作台模式，或多控模式下聚焦某台服务器
  multi.hidden = true;
  const s = byId(state.multiFocus) || byId(state.activeId) || state.sessions.find((x) => x.status === 'open');
  if (s) {
    state.activeId = s.id;
    work.hidden = false;
    attachHost(s.host, $('#termWork'));
  } else {
    work.hidden = true;
    empty.hidden = false;
  }
}

/* ---------------- 会话列表渲染 ---------------- */
export function renderSessionList() {
  const list = $('#sessionList');
  const multi = state.mode === 'multi';
  $('#sessionsTitle').textContent = multi ? '选择服务器' : '会话';
  $('#btnSelectAll').style.display = multi ? '' : 'none';

  if (!state.sessions.length) {
    const es = h('div', 'empty-state');
    es.innerHTML =
      '<div class="es-ico">' + menuIcon('terminal') + '</div>' +
      '<div class="es-t">暂无会话</div>' +
      '<div class="es-s">双击左侧主机，或在此处右键新建会话</div>';
    const btn = h('button', 'es-btn');
    btn.innerHTML = menuIcon('plus') + '<span>新建主机</span>';
    btn.addEventListener('click', () => import('./servers.js').then((m) => m.hostModal()));
    es.appendChild(btn);
    list.innerHTML = '';
    list.appendChild(es);
    $('#sessionsCount').textContent = '0';
    return;
  }

  // 多控模式：同一服务器合并为一个可选卡片
  if (multi) {
    $('#sessionsCount').textContent = String(state.servers.filter((s) => byServer(s.id).length).length);
    const frag = document.createDocumentFragment();
    const order = [];
    state.groups.forEach((g) => state.servers.filter((s) => s.group === g).forEach((s) => order.push(s)));
    state.servers.forEach((s) => { if (!order.includes(s)) order.push(s); });
    let idx = 0;
    order.forEach((srv) => {
      const ss = byServer(srv.id);
      if (!ss.length) return;
      const sel = state.multiSelected.includes(srv.id);
      const live = ss.find((s) => s.status === 'open');
      const card = h('div', `pick-item${sel ? ' sel' : ''}${live ? '' : ' dim'}`);
      card.innerHTML =
        '<span class="pick-check"><svg viewBox="0 0 24 24" fill="none"><path d="M4.5 12.5l4.6 4.6L19.5 6.8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
        `<span class="pick-main"><span class="pick-name">${esc(srv.name)}${ss.length > 1 ? `<i>${ss.length} 会话</i>` : ''}</span>` +
        `<span class="pick-sub">${esc(srv.ip)} · ${esc(live ? live.user + '@' : '')}${esc(srv.user)}${srv.proxy_id ? ' · 代理' : ''}</span></span>` +
        `<span class="pick-right">${live ? '<span class="pick-dot"></span>' : '<span class="pick-dot" style="background:var(--text-faint);opacity:.4"></span>'}` +
        `<span class="pick-idx" style="${sel ? '' : 'display:none'}">${++idx}</span></span>`;
      card.addEventListener('click', (e) => toggleMultiSelect(srv.id, e.shiftKey));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openCtx(e.clientX, e.clientY, [
          { title: srv.name, sub: `${srv.ip} · ${ss.length} 个会话`, icon: 'host' },
          { label: sel ? '取消选择' : '选择此服务器', icon: sel ? 'close' : 'check', act: () => toggleMultiSelect(srv.id, false) },
          { sep: true },
          { label: '仅显示此服务器', icon: 'filter', act: () => import('./multi.js').then((m) => m.setMultiFilter(srv.id)) },
          { label: '新建会话', icon: 'plus', act: () => createSession(srv) }
        ]);
      });
      frag.appendChild(card);
    });
    list.innerHTML = '';
    list.appendChild(frag);
    return;
  }

  // 工作台模式：命令 / 响应预览卡片
  $('#sessionsCount').textContent = String(state.sessions.length);
  list.innerHTML = '';
  state.sessions.forEach((s) => {
    const card = h('div', `sess-card${s.id === state.activeId ? ' active' : ''}${s.status === 'open' ? ' is-live' : ''}`);
    const thumb = h('div', 'sess-thumb');
    const pv = h('div', 'pv');
    pv.innerHTML =
      '<div class="pv-cmd"><span class="pv-chev">$</span><span class="pv-cmd-t"></span></div>' +
      '<div class="pv-out"></div>';
    thumb.appendChild(pv);
    const unread = s.unread ? '<span class="unread" data-tip="有新输出"></span>' : '';
    card.appendChild(thumb);
    const meta = h('div', 'sess-meta');
    meta.innerHTML =
      `<div class="sess-meta-1"><span class="sess-name">${esc(s.name)} <i>[${s.index}]</i>${unread}</span>` +
      `<span class="sess-sub">${esc(s.ip)} · ${esc(statusText(s))}</span></div>` +
      `<button class="mini-btn sess-close" data-tip="断开并关闭"><svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
    card.appendChild(meta);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.sess-close')) { closeSession(s); return; }
      if (state.mode === 'multi') { setMultiFilterTo(s.serverId); return; }
      activate(s.id);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const st = s.status === 'open' ? '已连接' : s.status === 'connecting' ? '连接中' : '已断开';
      openCtx(e.clientX, e.clientY, [
        { title: `${s.name}[${s.index}]`, sub: `${s.ip} · ${s.user} · ${st}`, icon: 'terminal' },
        { label: '切换到此会话', icon: 'eye', act: () => activate(s.id) },
        { label: '新建同类会话', icon: 'plus', kbd: 'Ctrl T', act: () => createSession(getServer(s.serverId)) },
        { label: '文件管理', icon: 'folder', kbd: 'Ctrl B', act: () => import('./files.js').then((m) => m.toggleFiles()) },
        { sep: true },
        { label: '断开连接', icon: 'unlink', danger: true, act: () => closeSession(s) }
      ]);
    });
    s.cardEl = card;
    s.pvEl = pv;
    list.appendChild(card);
    paintPreview(s);
  });
}

/* ---------------- 会话栏空白右键 ---------------- */
export function initSessionColumn() {
  const col = $('#sessionsCol');
  if (!col) return;
  col.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.sess-card, .pick-item, button, input')) return;
    e.preventDefault();
    const cur = byId(state.activeId) || state.sessions[0];
    openCtx(e.clientX, e.clientY, [
      { title: '会话管理', sub: `${state.sessions.length} 个会话 · ${state.mode === 'multi' ? '多控模式' : '工作台模式'}`, icon: 'layers' },
      {
        label: '新建会话', icon: 'plus', kbd: 'Ctrl T', disabled: !cur && !state.servers.length,
        act: () => { const s = cur ? getServer(cur.serverId) : state.servers[0]; if (s) createSession(s); }
      },
      { sep: true },
      {
        label: state.mode === 'multi' ? '切换到工作台模式' : '切换到多控模式',
        icon: 'layers', kbd: 'Ctrl ⇧ M',
        act: () => switchMode(state.mode === 'multi' ? 'workbench' : 'multi')
      },
      {
        label: '全选 / 反选服务器', icon: 'selectAll', disabled: state.mode !== 'multi',
        act: () => {
          state.multiSelected = state.multiSelected.length === state.servers.length
            ? [] : state.servers.map((s) => s.id);
          import('./multi.js').then((m) => m.onMultiSelectionChanged());
          renderSessionList();
        }
      },
      { sep: true },
      { label: '收起会话栏', icon: 'panelLeft', act: () => toggleCol('sessions', true) }
    ]);
  });
}

/* ---------------- 未读 ---------------- */
export function markUnread(sess) {
  if (!sess || sess.id === state.activeId) return;
  if (sess.unread) return;
  sess.unread = true;
  const card = sess.cardEl;
  if (card && !card.querySelector('.unread')) {
    const name = card.querySelector('.sess-name');
    if (name) name.insertAdjacentHTML('beforeend', '<span class="unread" data-tip="有新输出"></span>');
  }
}

/* ---------------- 会话预览：最新命令 + 响应 ---------------- */
/** 提示符回显行（`[root@h /app]# pwd`）：捕获组 1 为用户实际执行的完整命令 */
const ECHO_CMD = /^\s*(?:\([^)]*\)\s*)*(?:\[[^\]]*\]|[\w.-]+@[\w.-]+[^#$>%]*|[A-Za-z0-9_.-]+)[#$>%]\s+(.+)$/;
const PV_MAX_LINES = 40;      // 环形缓冲上限
const PV_SHOW_LINES = 6;      // 卡片内可见行数（预览区固定 138px 高，可容纳 6 行）

/**
 * 输出流入：把 PTY 数据拆成行写入会话预览缓冲。
 * 只做纯文本处理（去 ANSI、截断超长行），不做任何 DOM 操作，
 * 真正的渲染由 480ms 的预览循环按 dirty 标记批量完成。
 */
export function notePreview(sess, data) {
  if (!sess) return;
  const pv = sess.pv || (sess.pv = { lines: [], dirty: true });
  // \r 也作为行结束符：跨包到达的回显行可能只以 \r 结尾（如逐字符回显的补全后缀）
  let buf = (sess.__pvBuf || '') + stripAnsi(String(data));
  const parts = buf.split(/\r\n|\r|\n/);
  buf = parts.pop() ?? '';
  for (const rawLine of parts) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) {
      if (pv.lines.length && pv.lines[pv.lines.length - 1] !== '') pv.lines.push('');
      continue;
    }
    // 命令回显行（提示符 + 命令）：不进预览，命令本身已由「回车时读终端缓冲」记录，
    // 这样 Tab 补全 / 历史 / 光标编辑后的命令都不会错乱
    if (ECHO_CMD.test(line)) continue;
    // 登录横幅与纯提示符行对「最新命令 + 响应」没有信息量，直接跳过
    if (/^\s*(Last login:|Welcome to )/.test(line)) continue;
    if (/^(?:\[[^\]]*\]|[\w.@:~\\/-]+)[#$>%]\s*$/.test(line)) continue;
    if (/^\s*──.*已连接\s*──\s*$/.test(line)) continue;
    pv.lines.push(line.length > 200 ? line.slice(0, 199) + '…' : line);
  }
  if (pv.lines.length > PV_MAX_LINES) pv.lines.splice(0, pv.lines.length - PV_MAX_LINES);
  sess.__pvBuf = buf.slice(-400);
  pv.dirty = true;
}

/** 把预览数据刷到卡片 DOM（复用行节点，避免整体重建） */
export function paintPreview(sess) {
  const el = sess.pvEl;
  const pv = sess.pv;
  if (!el || !pv || !el.isConnected) return;

  const cmdEl = el.querySelector('.pv-cmd-t');
  const cmd = sess.lastCmd || '';
  const cmdText = cmd || (sess.status === 'open' ? '等待操作…' : sess.status === 'connecting' ? '连接中…' : sess.status === 'reconnecting' ? `重连中 ${sess.reconnectAttempt || 1}/${RECONNECT_MAX}…` : '未连接');
  if (cmdEl.textContent !== cmdText) cmdEl.textContent = cmdText;
  el.classList.toggle('is-idle', !cmd);

  const out = el.querySelector('.pv-out');
  const lines = pv.lines.slice(-PV_SHOW_LINES);
  while (out.children.length < lines.length) out.appendChild(h('div', 'pv-l'));
  while (out.children.length > lines.length) out.removeChild(out.lastChild);
  lines.forEach((ln, i) => {
    const d = out.children[i];
    const t = ln === '' ? ' ' : ln;
    if (d.textContent !== t) d.textContent = t;
  });
  pv.dirty = false;
}

/**
 * 预览刷新循环：约 2fps，只重绘有变化的卡片。
 * 高频输出（tail -f / yes）不会触发逐行重排，性能开销可忽略。
 */
export function startPreviewLoop() {
  setInterval(() => {
    state.sessions.forEach((s) => {
      if (!s.pv || !s.pv.dirty) return;
      if (!s.pvEl || !s.pvEl.isConnected) return;
      try { paintPreview(s); } catch (_) { /* 卡片已销毁 */ }
    });
  }, 480);
}

/* ---------------- 多控选择 ---------------- */
async function toggleMultiSelect(serverId, shift) {
  const order = selectableOrder();
  const has = state.multiSelected.includes(serverId);
  if (shift && state.multiSelected.length) {
    const anchor = order.indexOf(state.multiSelected[state.multiSelected.length - 1]);
    const target = order.indexOf(serverId);
    if (anchor >= 0 && target >= 0) {
      const [a, b] = anchor < target ? [anchor, target] : [target, anchor];
      const range = order.slice(a, b + 1);
      if (has) state.multiSelected = state.multiSelected.filter((id) => !range.includes(id));
      else range.forEach((id) => { if (!state.multiSelected.includes(id)) state.multiSelected.push(id); });
    }
  } else if (has) {
    state.multiSelected = state.multiSelected.filter((id) => id !== serverId);
  } else {
    state.multiSelected.push(serverId);
  }
  const { onMultiSelectionChanged } = await import('./multi.js');
  onMultiSelectionChanged();
  renderSessionList();
}

export function selectableOrder() {
  const order = [];
  state.groups.forEach((g) => state.servers.filter((s) => s.group === g).forEach((s) => order.push(s.id)));
  state.servers.forEach((s) => { if (!order.includes(s.id)) order.push(s.id); });
  return order.filter((id) => byServer(id).length > 0);
}

export function setMultiFilterTo(serverId) {
  import('./multi.js').then((m) => m.setMultiFilter(serverId));
}
