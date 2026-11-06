/**
 * 主工作区：状态栏 / 快捷命令栏 / 命令输入行 / 模式切换 / 主题 / 搜索 / 菜单
 */
import { state, byId, byServer, active, getServer, persistSoon, persist, addHistory, HISTORY_MAX } from './state.js';
import { invoke } from './api.js';
import { $, $$, h, esc, toast, openCtx, menuIcon, fmtSize } from './ui.js';
import { xtermTheme, applyTermSettings } from './term.js';
import { broadcast, multiTerm, renderFilterTabs, setMultiFilter, getMultiSearch, getMultiHost } from './multi.js';
import { renderMainVisibility, renderSessionList, activate } from './sessions.js';
import { noteCommand } from './cwd.js';
import { applyWindowMaterial } from './desktop.js';

/* ---------------- 状态栏 ---------------- */
export function refreshServerFoot() {
  const live = new Set(state.sessions.filter((s) => s.status === 'open').map((s) => s.serverId)).size;
  const el = $('#serverFootText');
  if (el) el.textContent = `${state.servers.length} 台主机 · ${live} 台已连接${state.proxies.length ? ` · ${state.proxies.length} 个代理` : ''}`;
}

export function renderStatus() {
  const bar = $('#statusbar');
  if (state.mode === 'multi' && !state.multiFocus) {
    const n = state.multiSelected.length;
    const live = state.multiSelected.filter((sid) => byServer(sid).some((s) => s.status === 'open')).length;
    bar.innerHTML =
      '<span class="sb-dot on"></span>' +
      `<span class="sb-item strong">多控模式 · 已选 ${n} 台 · ${live} 台在线</span>` +
      '<span class="sb-sep"></span>' +
      '<span class="sb-item">命令将并发执行并聚合输出</span>' +
      '<span class="sb-right"><span id="sbMode">多控模式</span></span>';
    return;
  }
  const s = active();
  if (!s) {
    bar.innerHTML = '<span class="sb-dot off"></span><span class="sb-item">未连接</span>' +
      '<span class="sb-right"><span class="buf" id="sbMode">工作台模式</span></span>';
    return;
  }
  const dot = s.status === 'open' ? 'on' : 'off';
  const label = s.status === 'open' ? '' : s.status === 'connecting' ? ' · 连接中' : ' · 已断开';
  bar.innerHTML =
    `<span class="sb-dot ${dot}"></span>` +
    `<span class="sb-item strong">${esc(s.ip)}<b>[${s.index}]</b>${esc(label)}</span>` +
    '<span class="sb-sep"></span>' +
    `<span class="sb-item">${esc(s.user)}@${esc(s.name)}</span>` +
    '<span class="sb-sep"></span>' +
    cwdHTML(s) +
    `<span class="sb-right"><span class="buf">${s.status === 'open' ? 'SSH 已连接' : ''}</span>` +
    `<span id="sbMode">${state.mode === 'multi' ? '多控模式' : '工作台模式'}</span></span>`;
}

/** 状态栏里的当前目录：文字 + 一键复制按钮（右键还有菜单） */
function cwdHTML(s) {
  const cwd = s.cwd || '/';
  return '<span class="sb-item sb-cwd" id="sbCwd" data-cwd="' + esc(cwd) + '" data-tip="右键复制 / 打开">' +
    '<span class="sb-cwd-t">' + esc(cwd) + '</span>' +
    '<button class="sb-copy" id="sbCwdCopy" type="button" data-tip="复制当前目录">' +
      '<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="10.5" height="10.5" rx="2.2" stroke="currentColor" stroke-width="1.6"/>' +
      '<path d="M15 9V6.6A2.6 2.6 0 0 0 12.4 4H6.6A2.6 2.6 0 0 0 4 6.6v5.8A2.6 2.6 0 0 0 6.6 15H9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
    '</button></span>';
}

/** 复制当前活动会话的目录并给出反馈 */
export async function copyCwd(sess) {
  const s = sess || active();
  if (!s) return false;
  const cwd = s.cwd || '/';
  const { copyText } = await import('./desktop.js');
  const ok = await copyText(cwd);
  toast(ok ? `已复制：${cwd}` : '复制失败（剪贴板不可用）', ok ? 'ok' : 'warn');
  return ok;
}

/** 复制成可直接执行的 `cd <dir>`（含空格时自动加引号） */
export async function copyCd(sess) {
  const s = sess || active();
  if (!s) return false;
  const cwd = s.cwd || '/';
  const line = /\s/.test(cwd) ? `cd '${cwd.replace(/'/g, `'\\''`)}'` : `cd ${cwd}`;
  const { copyText } = await import('./desktop.js');
  const ok = await copyText(line);
  toast(ok ? `已复制：${line}` : '复制失败（剪贴板不可用）', ok ? 'ok' : 'warn');
  return ok;
}

/* ---------------- 快捷 / 历史命令栏 ----------------
   两栏独立成行，是否展示由设置里的 showQuickBar / showHistoryBar 控制；
   两者都关闭时整块隐藏，主终端获得更多垂直空间。
   ------------------------------------------------ */
export function renderPalette() {
  const stack = $('#palette');
  if (!stack) return;
  const showQuick = state.settings.showQuickBar !== false;
  const showHist = state.settings.showHistoryBar !== false;
  stack.hidden = !showQuick && !showHist;
  renderQuickRow(showQuick);
  renderHistoryRow(showHist);
}

function palLabel(icon, text) {
  const s = h('span', 'pal-label');
  s.innerHTML = menuIcon(icon) + '<span>' + esc(text) + '</span>';
  return s;
}

function renderQuickRow(show) {
  const row = $('#paletteQuick');
  if (!row) return;
  row.hidden = !show;
  row.innerHTML = '';
  if (!show) return;

  row.appendChild(palLabel('command', '快捷'));
  if (!state.quickCommands.length) {
    row.appendChild(h('span', 'pal-hint', '把常用命令固定在这里'));
  }
  state.quickCommands.forEach((q, i) => {
    const c = h('button', 'chip quick', esc(q.label));
    c.dataset.tip = q.cmd;
    c.addEventListener('click', () => sendCommand(q.cmd));
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, [
        { title: q.label, sub: q.cmd, icon: 'command' },
        { label: '立即执行', icon: 'terminal', act: () => sendCommand(q.cmd) },
        { sep: true },
        { label: '编辑快捷命令', icon: 'pencil', act: () => quickCmdModal(i) },
        {
          label: '删除', icon: 'trash', danger: true, kbd: 'Del',
          act: () => { state.quickCommands.splice(i, 1); persist(); renderPalette(); }
        }
      ]);
    });
    row.appendChild(c);
  });

  const add = h('button', 'chip add');
  add.innerHTML = menuIcon('plus') + '<span>快捷命令</span>';
  add.addEventListener('click', () => quickCmdModal(-1));
  row.appendChild(add);
}

function renderHistoryRow(show) {
  const row = $('#paletteHistory');
  if (!row) return;
  row.hidden = !show;
  row.innerHTML = '';
  if (!show) return;

  row.appendChild(palLabel('history', '历史'));
  if (!state.history.length) {
    row.appendChild(h('span', 'pal-hint', `执行过的命令保留最近 ${HISTORY_MAX} 条`));
    return;
  }
  state.history.slice(-HISTORY_MAX).reverse().forEach((c) => {
    const b = h('button', 'chip', esc(c));
    b.addEventListener('click', () => sendCommand(c));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, [
        { title: '历史命令', sub: c, icon: 'history' },
        { label: '再次执行', icon: 'terminal', act: () => sendCommand(c) },
        { label: '填回输入框', icon: 'pencil', act: () => { const inp = $('#cmdInput'); inp.value = c; inp.focus(); } },
        { sep: true },
        {
          label: '从历史中移除', icon: 'trash', danger: true,
          act: () => { const i = state.history.indexOf(c); if (i >= 0) state.history.splice(i, 1); persistSoon(); renderPalette(); }
        },
        {
          label: `清空历史命令`, icon: 'clear', danger: true,
          act: () => { state.history = []; persistSoon(); renderPalette(); toast('历史命令已清空'); }
        }
      ]);
    });
    row.appendChild(b);
  });
}

function quickCmdModal(index) {
  const editing = index >= 0 ? state.quickCommands[index] : { label: '', cmd: '' };
  import('./ui.js').then(({ openModal }) => {
    const mask = openModal(
      '<div class="field"><label>名称</label><input id="qcLabel" placeholder="如：查看磁盘" value="' + esc(editing.label) + '"/></div>' +
      '<div class="field"><label>命令</label><input id="qcCmd" placeholder="如：df -h" value="' + esc(editing.cmd) + '"/></div>' +
      '<div class="m-foot"><span class="spacer"></span><button class="btn" data-close>取消</button><button class="btn primary" id="qcSave">保存</button></div>',
      { title: index >= 0 ? '编辑快捷命令' : '新建快捷命令' }
    );
    mask.querySelector('#qcSave').addEventListener('click', async () => {
      const label = mask.querySelector('#qcLabel').value.trim() || '未命名';
      const cmd = mask.querySelector('#qcCmd').value.trim();
      if (!cmd) { toast('命令不能为空', 'warn'); return; }
      if (index >= 0) state.quickCommands[index] = { label, cmd };
      else state.quickCommands.push({ label, cmd });
      // 立即落盘（不走 400ms 防抖）：刚加完就关窗口也不会丢
      await persist();
      renderPalette();
      mask.close();
    });
    mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
  });
}

/* ---------------- 命令发送 ---------------- */
export function sendCommand(cmd) {
  const c = String(cmd || '');
  if (!c.trim()) return;
  if (state.mode === 'multi') {
    // 没有选中服务器、或命令被多控拦截时 broadcast 返回 false：
    // 这一条并没有发出去，输入框要保留内容，否则用户点「取消」后得重敲
    if (broadcast(c) === false) return;
  } else {
    const s = active();
    if (!s || s.status !== 'open') { toast('当前没有已连接的会话', 'warn'); return; }
    noteCommand(s, c);   // 先预测 cwd，再发命令：后续输出行的前缀才会是新目录
    invoke('ssh_write', { sessionId: s.id, data: c + '\n' }).catch(() => {});
    pushHistoryLocal(c);
  }
  $('#cmdInput').value = '';
  resetHistoryNav();
  hideComplete();
}

function pushHistoryLocal(line) {
  // 统一走 state.addHistory：去重 + 只留最近 20 条 + 异步落盘
  addHistory(line);
  renderPalette();
}

export function renderInputPrompt() {
  const p = $('#inputPrompt');
  if (state.mode === 'multi') {
    const n = state.multiSelected.length;
    p.className = 'prompt multi';
    p.innerHTML = `<span class="pp">❯ 广播</span><span>${n ? n + ' 台服务器' : '未选择'}</span>`;
    $('#cmdInput').placeholder = '输入命令，Enter 并发执行到所有已选服务器';
  } else {
    const s = active();
    p.className = 'prompt';
    p.innerHTML = s ? `<span class="pp">${esc(s.user)}@${esc(s.name)}</span><span>${esc(s.cwd || '/')}</span>` : '<span>—</span>';
    $('#cmdInput').placeholder = '输入命令，Enter 执行 · 终端内可直接输入，Tab 由远程 shell 补全';
  }
}

/* ---------------- 模式切换 ---------------- */
export function switchMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.multiFocus = null;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
  positionGlider();
  if (mode === 'multi') {
    // 默认选中所有已连接会话的服务器
    if (!state.multiSelected.length) {
      state.servers.forEach((srv) => { if (byServer(srv.id).some((s) => s.status === 'open')) state.multiSelected.push(srv.id); });
    }
    import('./multi.js').then((m) => m.onMultiSelectionChanged());
  } else {
    state.multiFocus = null;
  }
  renderMainVisibility();
  renderSessionList();
  renderFilterTabs();
  renderInputPrompt();
  renderStatus();
  const sb = $('#sbMode');
  if (sb) sb.textContent = mode === 'multi' ? '多控模式' : '工作台模式';
}

export function positionGlider() {
  const activeBtn = document.querySelector('.mode-btn.is-active');
  const glider = $('#glider');
  if (activeBtn && glider) {
    glider.style.width = activeBtn.offsetWidth + 'px';
    glider.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
  }
}

/* ---------------- 主题 ---------------- */
export function applyTheme() {
  const s = state.settings;
  const html = document.documentElement;
  html.dataset.theme = s.theme === 'light' ? 'light' : 'dark';
  html.dataset.pure = s.pure && s.theme !== 'light' ? 'true' : 'false';
  applyTermSettings(allHosts());
  document.dispatchEvent(new CustomEvent('lc-theme'));
  // Mica 的明暗是窗口级状态，跟随主题重新下发给系统
  applyWindowMaterial();
}

function allHosts() {
  const hosts = [];
  state.sessions.forEach((s) => s.host && hosts.push(s.host));
  // 多控聚合终端也是一个真实 xterm：不带上它，改字号/主题时聚合视图不生效
  const mh = getMultiHost();
  if (mh) hosts.push(mh);
  return hosts;
}

/* ---------------- 补全弹层（远程路径 + 本地命令池 + 历史） ---------------- */
const CMDS = [
  ['ls', '列出目录'], ['ls -lah', '详细列出'], ['cd', '切换目录'], ['pwd', '当前目录'],
  ['cat', '查看文件'], ['less', '分页查看'], ['tail -f', '跟踪日志'], ['head', '头部查看'],
  ['grep -rn', '文本搜索'], ['find . -name', '查找文件'], ['df -h', '磁盘用量'], ['du -sh *', '目录大小'],
  ['free -m', '内存'], ['top', '进程监控'], ['htop', '进程监控'], ['ps aux', '进程列表'],
  ['uptime', '运行时长'], ['who', '登录用户'], ['netstat -tlnp', '端口监听'], ['ss -tlnp', '端口监听'],
  ['systemctl status', '服务状态'], ['systemctl restart', '重启服务'], ['journalctl -xe', '系统日志'],
  ['journalctl -u', '服务日志'], ['ip a', '网络地址'], ['ping', '连通测试'], ['curl -I', 'HTTP 探测'],
  ['wget', '下载'], ['tar -xzvf', '解压'], ['tar -czvf', '压缩'], ['chmod +x', '加执行权限'],
  ['chown -R', '改属主'], ['vim', '编辑器'], ['nano', '编辑器'], ['scp', '远程拷贝'],
  ['rsync -avz', '增量同步'], ['crontab -l', '定时任务'], ['docker ps', '容器列表'],
  ['docker logs -f', '容器日志'], ['kubectl get pods', 'K8s Pod'], ['nginx -t', 'Nginx 语法检查'],
  ['systemctl reload nginx', '重载 Nginx'], ['tail -n 100', '查看尾部'], ['history', '命令历史'],
  ['dmesg | tail', '内核消息'], ['lscpu', 'CPU 信息'], ['lsblk', '块设备'], ['iostat -x 1', 'IO 统计']
];

let cpItems = [], cpIndex = 0;
let cpTokenReplace = false;   // true：只替换最后一个 token（路径补全）
let cpTokenStart = 0;         // 最后一个 token 的起始下标
let querySeq = 0;             // 异步补全结果防串号

function rxesc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

let cpHl = '';
export function showComplete(items, opt = {}) {
  const pop = $('#completePop');
  cpItems = items;
  cpIndex = Math.min(cpIndex, items.length - 1);
  cpTokenReplace = !!opt.tokenReplace;
  cpTokenStart = opt.tokenStart || 0;
  cpHl = opt.hl ?? '';
  const hl = rxesc(cpHl);
  pop.innerHTML = items.map((it, i) =>
    `<div class="cp-item${i === cpIndex ? ' sel' : ''}" data-i="${i}">` +
    `<span class="cp-ico">${i === cpIndex ? '▸' : '·'}</span>` +
    `<span>${hl ? esc(it.label).replace(new RegExp('^(' + hl + ')', 'i'), '<b>$1</b>') : esc(it.label)}</span>` +
    `<span class="cp-desc">${esc(it.desc || '')}</span></div>`).join('');
  const r = $('#cmdInput').getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = r.left + 'px';
  pop.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  pop.style.top = 'auto';
  pop.querySelectorAll('.cp-item').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      cpIndex = +el.dataset.i;
      applyComplete();
    });
  });
}
export function hideComplete() { $('#completePop').hidden = true; cpItems = []; }
export function completeVisible() { return !$('#completePop').hidden && cpItems.length > 0; }
export function completeNav(dir) {
  if (!cpItems.length) return;
  cpIndex = (cpIndex + dir + cpItems.length) % cpItems.length;
  showComplete(cpItems, { tokenReplace: cpTokenReplace, tokenStart: cpTokenStart, hl: cpHl });
}
export function applyComplete() {
  if (!cpItems.length) return;
  const it = cpItems[cpIndex];
  const input = $('#cmdInput');
  if (cpTokenReplace) {
    input.value = input.value.slice(0, cpTokenStart) + it.value;
    const end = input.value.length;
    input.setSelectionRange(end, end);
  } else {
    input.value = it.value;
  }
  hideComplete();
  input.focus();
}

/* ---------------- 历史命令导航（输入行 ↑ / ↓） ---------------- */
let histPos = null, histDraft = '';
function resetHistoryNav() { histPos = null; }
function historyNav(dir) {
  const input = $('#cmdInput');
  const h = state.history;
  if (!h.length) return;
  if (histPos === null) {
    if (dir > 0) return;
    histDraft = input.value;
    histPos = h.length - 1;
  } else {
    histPos += dir;
    if (histPos >= h.length) {
      histPos = null;
      input.value = histDraft;
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (histPos < 0) histPos = 0;
  }
  input.value = h[histPos] ?? '';
  input.setSelectionRange(input.value.length, input.value.length);
  hideComplete();
}

/* ---------------- 远程路径补全（cd /var/lo<Tab> → /var/log/） ---------------- */
const dirCache = new Map();          // path -> { at, entries }
const DIR_CACHE_TTL = 8000;
export function invalidateDirCache() { dirCache.clear(); }

function listRemoteDir(sess, path) {
  const hit = dirCache.get(path);
  const now = Date.now();
  if (hit && now - hit.at < DIR_CACHE_TTL) return Promise.resolve(hit.entries);
  return invoke('sftp_list', { sessionId: sess.id, path })
    .then((entries) => { dirCache.set(path, { at: now, entries: entries || [] }); return entries || []; })
    .catch(() => []);
}

/** 把用户输入的路径片段（~/x、/a/b、相对目录）解析为绝对目录 */
function resolveDir(sess, dirPart) {
  const home = sess.user === 'root' ? '/root' : `/home/${sess.user || 'user'}`;
  let p = sess.cwd || '/';
  if (dirPart.startsWith('~')) p = dirPart === '~' ? home : home + dirPart.slice(1);
  else if (dirPart.startsWith('/')) p = dirPart;
  else if (dirPart) p = p.replace(/\/+$/, '') + '/' + dirPart;
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return '/' + out.join('/');
}

function lastToken(v) {
  const m = /(\S*)$/.exec(v);
  return { token: m[1], start: v.length - m[1].length };
}

export async function queryComplete(input) {
  const { token, start } = lastToken(input);
  const atCommand = input.slice(0, start).trim() === '';
  const s = state.mode === 'multi' ? null : active();

  // 参数位 + 已连接会话：远程路径补全（绝对 / 相对 / ~ 均支持）
  if (!atCommand && s && s.status === 'open') {
    let dirPart = '', frag = token;
    if (token.includes('/') || token.startsWith('~')) {
      const si = token.lastIndexOf('/');
      if (si >= 0) { dirPart = token.slice(0, si + 1); frag = token.slice(si + 1); }
      else { dirPart = '~'; frag = ''; }
    }
    const dir = resolveDir(s, dirPart);
    const entries = await listRemoteDir(s, dir);
    const fragLc = frag.toLowerCase();
    const items = entries
      .filter((e) => e.name && e.name !== '.' && e.name !== '..' && e.name.toLowerCase().startsWith(fragLc))
      .sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name))
      .slice(0, 24)
      .map((e) => {
        const val = dirPart + e.name + (e.is_dir ? '/' : '');
        return { label: val, value: val, desc: e.is_dir ? '目录' : fmtSize(e.size) };
      });
    return { items, tokenReplace: true, tokenStart: start, hl: frag };
  }

  // 命令位：本地命令池 + 历史 + 快捷命令
  const v = token.trim().toLowerCase();
  if (!v) return { items: [] };
  const pool = [];
  CMDS.forEach(([label, desc]) => pool.push({ label, desc, value: label }));
  state.history.forEach((c) => pool.push({ label: c, desc: '历史', value: c }));
  state.quickCommands.forEach((q) => pool.push({ label: q.label, desc: q.cmd, value: q.cmd }));
  const seen = new Set();
  const out = [];
  for (const it of pool) {
    if (out.length >= 8) break;
    if (seen.has(it.label + it.value)) continue;
    if (it.label.toLowerCase().startsWith(v) || it.value.toLowerCase().startsWith(v)) { seen.add(it.label + it.value); out.push(it); }
  }
  return { items: out, hl: token };
}

/** 带防串号的异步补全查询 */
async function queryAsync(value) {
  const seq = ++querySeq;
  const r = await queryComplete(value);
  if (seq !== querySeq) return { items: [] };
  return r;
}

/** Tab 补全：唯一匹配直接补上并继续下钻（目录会追加 / 后列出内容） */
function applyToken(r) {
  cpItems = r.items;
  cpIndex = 0;
  cpTokenReplace = !!r.tokenReplace;
  cpTokenStart = r.tokenStart || 0;
  applyComplete();
}
async function tabComplete(depth = 0) {
  if (depth > 8) return;
  const input = $('#cmdInput');
  if (completeVisible()) applyComplete();          // 已有弹层：确认当前高亮项
  const r = await queryAsync(input.value);
  if (!r.items.length) { hideComplete(); return; }
  if (r.items.length === 1) {                      // 唯一匹配：直接补上，不弹层
    applyToken(r);
    await tabComplete(depth + 1);
    return;
  }
  cpIndex = 0;
  showComplete(r.items, r);
}

/* ---------------- 初始化静态交互 ---------------- */
export function initWorkspace() {
  // 主菜单图标（与右键菜单共用同一套图标与视觉）
  $$('#mainMenu [data-icon]').forEach((b) => {
    const ico = b.querySelector('.ctx-ico');
    if (ico) ico.innerHTML = menuIcon(b.dataset.icon);
  });

  // 终端空状态引导
  $('#teNewHost')?.addEventListener('click', () => import('./servers.js').then((m) => m.hostModal()));

  // 状态栏「当前目录」：点按钮复制、右键菜单（renderStatus 会重建 DOM，故用事件委托）
  const bar = $('#statusbar');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('#sbCwdCopy');
    if (!btn) return;
    e.stopPropagation();
    copyCwd();
  });
  bar.addEventListener('contextmenu', (e) => {
    const cwdEl = e.target.closest('#sbCwd');
    if (!cwdEl) return;
    e.preventDefault();
    const s = active();
    if (!s) return;
    const cwd = s.cwd || '/';
    openCtx(e.clientX, e.clientY, [
      { title: '当前目录', sub: `${s.name}[${s.index}] · ${cwd}`, icon: 'folder' },
      { label: '复制路径', icon: 'copy', act: () => copyCwd(s) },
      { label: '复制为 cd 命令', icon: 'terminal', act: () => copyCd(s) },
      { sep: true },
      { label: '在文件管理中打开', icon: 'folder', act: () => import('./files.js').then((m) => m.openAt(cwd)) }
    ]);
  });

  // 主菜单
  $('#btnMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#mainMenu').classList.toggle('open');
  });
  $('#mainMenu').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    $('#mainMenu').classList.remove('open');
    if (act === 'new-host') import('./servers.js').then((m) => m.hostModal());
    else if (act === 'new-session') { const s = active() || state.sessions[0]; if (s) import('./sessions.js').then((m) => m.createSession(getServer(s.serverId))); }
    else if (act === 'files') import('./files.js').then((m) => m.toggleFiles());
    else if (act === 'settings') import('./settings.js').then((m) => m.settingsModal());
    else if (act === 'about') import('./settings.js').then((m) => m.aboutModal());
    else if (act === 'shortcuts') shortcutsModal();
  });

  // 模式切换
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.addEventListener('click', () => switchMode(b.dataset.mode));
  });

  // 主题
  $('#btnTheme').addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
    persistSoon();
    applyTheme();
  });

  // 设置
  $('#btnSettings').addEventListener('click', () => import('./settings.js').then((m) => m.settingsModal()));

  // 清屏
  $('#btnClear').addEventListener('click', () => {
    if (state.mode === 'multi') {
      import('./multi.js').then((m) => m.clearAggregate());
    } else {
      const s = active();
      if (s) { s.host.term.clear(); s.host.term.write('\x1b[2J\x1b[H'); }
    }
  });

  // 搜索
  initSearch();

  // 文件面板
  $('#btnFiles').addEventListener('click', () => import('./files.js').then((m) => m.toggleFiles()));

  // 折叠栏
  document.querySelectorAll('.col-collapse').forEach((b) => {
    b.addEventListener('click', () => toggleCol(b.dataset.col, true));
  });
  document.querySelectorAll('.col-rail').forEach((b) => {
    b.addEventListener('click', () => toggleCol(b.dataset.col, false));
  });

  // 会话栏宽度拖拽
  initSessionsResizer();

  // 输入行
  const input = $('#cmdInput');
  $('#btnSend').addEventListener('click', () => { if (completeVisible()) applyComplete(); else sendCommand(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (completeVisible()) completeNav(1); else historyNav(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (completeVisible()) completeNav(-1); else historyNav(-1); return; }
    if (e.key === 'Tab') { e.preventDefault(); tabComplete(); return; }
    if (e.key === 'Enter') { if (completeVisible()) { e.preventDefault(); applyComplete(); } else sendCommand(input.value); return; }
    if (e.key === 'Escape') hideComplete();
  });
  input.addEventListener('input', () => {
    resetHistoryNav();
    clearTimeout(input.__t);
    input.__t = setTimeout(async () => {
      if (!input.value.trim()) { hideComplete(); return; }
      const r = await queryAsync(input.value);
      if (r.items.length && input.value.trim()) { cpIndex = 0; showComplete(r.items, r); }
      else hideComplete();
    }, 120);
  });

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); import('./servers.js').then((m) => m.hostModal()); }
    else if (ctrl && e.key.toLowerCase() === 't') { e.preventDefault(); const s = active() || state.sessions[0]; if (s) import('./sessions.js').then((m) => m.createSession(getServer(s.serverId))); }
    else if (ctrl && e.key.toLowerCase() === 'b') { e.preventDefault(); import('./files.js').then((m) => m.toggleFiles()); }
    else if (ctrl && e.key === ',') { e.preventDefault(); import('./settings.js').then((m) => m.settingsModal()); }
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); switchMode(state.mode === 'multi' ? 'workbench' : 'multi'); }
    else if (e.key === 'Escape' && completeVisible()) hideComplete();
  });

  window.addEventListener('resize', () => { positionGlider(); });
}

export function toggleCol(col, collapse) {
  if (collapse) state.collapsedCols.add(col);
  else state.collapsedCols.delete(col);
  const el = col === 'sessions' ? $('#sessionsCol') : $('#serversCol');
  el.classList.toggle('collapsed', state.collapsedCols.has(col));
  // 会话栏的自定义宽度以内联样式保存：折叠时必须清除（内联优先级高于 .collapsed），
  // 展开时恢复，否则 34px 的折叠宽度会被覆盖
  if (col === 'sessions') {
    if (collapse) { el.style.width = ''; el.style.flexBasis = ''; }
    else applySessionsWidth();
  }
  setTimeout(() => {
    renderMainVisibility();
    import('./term.js').then((m) => m.refitVisible?.()).catch(() => {});
  }, 260);
}

/* ---------------- 会话栏宽度拖拽 ---------------- */
const SESS_MIN = 180, SESS_MAX = 560, SESS_DEFAULT = 246;

/** 应用持久化的会话栏宽度（仅展开状态） */
export function applySessionsWidth() {
  if (state.collapsedCols.has('sessions')) return;
  const el = $('#sessionsCol');
  if (!el) return;
  const w = Math.min(SESS_MAX, Math.max(SESS_MIN, +state.settings.sessionsWidth || SESS_DEFAULT));
  el.style.width = w + 'px';
  el.style.flexBasis = w + 'px';
}

function initSessionsResizer() {
  const col = $('#sessionsCol'), handle = $('#sessResizer');
  if (!col || !handle) return;
  applySessionsWidth();

  handle.addEventListener('pointerdown', (e) => {
    if (state.collapsedCols.has('sessions')) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    col.classList.add('resizing');
    const startX = e.clientX;
    const startW = col.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.round(Math.min(SESS_MAX, Math.max(SESS_MIN, startW + (ev.clientX - startX))));
      col.style.width = w + 'px';
      col.style.flexBasis = w + 'px';
    };
    const up = () => {
      handle.classList.remove('active');
      col.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      state.settings.sessionsWidth = Math.round(col.getBoundingClientRect().width);
      persistSoon();
      import('./term.js').then((m) => m.refitVisible?.()).catch(() => {});
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  handle.addEventListener('dblclick', () => {
    state.settings.sessionsWidth = SESS_DEFAULT;
    persistSoon();
    applySessionsWidth();
    import('./term.js').then((m) => m.refitVisible?.()).catch(() => {});
  });
}

function shortcutsModal() {
  import('./ui.js').then(({ openModal }) => {
    const rows = [
      ['Ctrl + N', '新建主机'], ['Ctrl + T', '为当前主机新建会话'], ['Ctrl + B', '打开 / 关闭文件面板'],
      ['Ctrl + ,', '偏好设置'], ['Ctrl + Shift + M', '切换 工作台 / 多控 模式'], ['Shift + 点击', '多控模式连选服务器'],
      ['Tab', '输入框内呼出补全 · 终端内发送给远程 shell'], ['Ctrl + C', '终端内 = 中断信号（无法复制）'],
      ['选中右键', '复制选中文本'], ['双击主机', '快速新建会话']
    ];
    openModal(
      '<div class="sec">' + rows.map(([k, d]) =>
        `<div class="row"><div class="r-label"><div class="r-title">${esc(d)}</div></div><span class="range-val" style="width:auto;padding:0 8px">${esc(k)}</span></div>`).join('') + '</div>',
      { title: '快捷键' }
    );
  });
}

/* ---------------- 搜索（正则 / 大小写） ---------------- */
function initSearch() {
  const input = $('#searchInput');
  const chipRegex = $('#chipRegex'), chipCase = $('#chipCase');
  let regex = false, caseSensitive = false;

  chipRegex.addEventListener('click', () => { regex = !regex; chipRegex.classList.toggle('on', regex); run(); });
  chipCase.addEventListener('click', () => { caseSensitive = !caseSensitive; chipCase.classList.toggle('on', caseSensitive); run(); });
  input.addEventListener('input', run);
  $('#searchClear').addEventListener('click', () => { input.value = ''; $('#searchClear').hidden = true; clearSearch(); $('#searchCount').textContent = ''; });

  function activeSearch() {
    if (state.mode === 'multi') return getMultiSearch();
    const s = active();
    return s ? s.host.search : null;
  }

  function decorations() {
    const dark = document.documentElement.dataset.theme !== 'light';
    return {
      matchBackground: dark ? 'rgba(232,196,104,.35)' : 'rgba(244,180,0,.30)',
      matchOverviewRuler: '#e8c468',
      activeMatchBackground: dark ? 'rgba(240,112,95,.55)' : 'rgba(210,74,56,.40)',
      activeMatchColorOverviewRuler: '#f0705f'
    };
  }

  function run() {
    $('#searchClear').hidden = !input.value;
    const addon = activeSearch();
    if (!addon) return;
    const q = input.value;
    if (!q) { clearSearch(); $('#searchCount').textContent = ''; return; }
    try {
      addon.findNext(q, { regex, caseSensitive, incremental: true, decorations: decorations() });
    } catch (e) {
      $('#searchCount').textContent = '正则无效';
    }
  }

  function clearSearch() {
    const addon = activeSearch();
    if (addon) try { addon.clearDecorations(); } catch (_) {}
  }

  // Enter / Shift+Enter 上下跳转
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const addon = activeSearch();
    if (!addon) return;
    try {
      if (e.shiftKey) addon.findPrevious(input.value, { regex, caseSensitive, decorations: decorations() });
      else addon.findNext(input.value, { regex, caseSensitive, decorations: decorations() });
    } catch (_) {}
  });

  // 结果计数
  setInterval(() => {
    const addon = activeSearch();
    if (!addon || !input.value) { if (!input.value) $('#searchCount').textContent = ''; return; }
    if (addon.getResultCount) {
      try {
        const r = addon.getResultCount();
        $('#searchCount').textContent = r ? (r.resultIndex >= 0 ? `${r.resultIndex + 1}/${r.resultCount}` : `${r.resultCount} 项`) : '0 项';
      } catch (_) {}
    }
  }, 400);

  // 搜索目标随视图切换
  document.addEventListener('lc-view-changed', () => run());
  document.addEventListener('lc-theme', () => { if (input.value) run(); });
}
