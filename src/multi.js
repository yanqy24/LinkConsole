/**
 * 多控模式：命令广播、输出聚合（带服务器前缀）、按服务器过滤
 */
import { state, byId, byServer, getServer } from './state.js';
import { invoke } from './api.js';
import { createHost, attachHost, isDark } from './term.js';
import { $, h, esc, toast, openModal, menuIcon } from './ui.js';
import { renderStatus, renderInputPrompt, switchMode } from './workspace.js';
import { renderMainVisibility, activate, pushHistory } from './sessions.js';
import { noteCommand } from './cwd.js';

let multiHost = null;

/** 聚合时间线：{ sid, serverId, name, ip, cwd, text } */
export const timeline = [];
const partials = new Map(); // sessionId -> 剩余半行
const MAX_TIMELINE = 20000;

/* ---------------- 聚合终端 ---------------- */
export function ensureMultiHost() {
  if (!multiHost) multiHost = createHost({});
  return multiHost;
}
export const multiTerm = () => multiHost?.term || null;
/** 聚合终端的宿主（可能尚未创建）；供全局字体 / 主题设置统一应用 */
export const getMultiHost = () => multiHost;

/** 聚合视图容器尺寸变化后重排（供 term.js 的 ResizeObserver 调用） */
export function refitMulti() {
  if (multiHost) { try { multiHost.fit.fit(); } catch (_) {} }
}
export function getMultiSearch() {
  return multiHost ? multiHost.search : null;
}

/** 清空聚合视图与缓冲 */
export function clearAggregate() {
  timeline.length = 0;
  partials.clear();
  if (multiHost) rebuildAggView();
}

export function attachMultiView() {
  const host = ensureMultiHost();
  const container = $('#termMulti');
  const el = host.term.element;
  if (!el || el.parentElement !== container) {
    // 不能 innerHTML='' 粗暴清空：那会把其它宿主的 element 从 DOM 摘掉并留下残影。
    // attachHost 会把容器里的旧宿主送回各自离屏池，保证同一时刻只有一个终端可见。
    attachHost(host, container);
    rebuildAggView();
  } else {
    try { host.fit.fit(); } catch (_) {}
  }
}

/* ---------------- 数据流入 ---------------- */
/** 单个会话的「半行」缓冲上限：\r 刷新型输出（docker pull / wget / curl 进度条）
    永远不带 \n，不设上限就会一路涨到几十 MB。超限时截尾提交一行再清空。 */
const MAX_PARTIAL = 32 * 1024;

export function feedMulti(sess, data) {
  if (!data) return;
  let buf = partials.get(sess.id);
  if (buf === undefined) { buf = ''; partials.set(sess.id, buf); }
  buf += data;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).replace(/\r+$/, '');
    buf = buf.slice(idx + 1);
    pushAggLine(sess, line);
  }
  if (buf.length > MAX_PARTIAL) {
    // 只保留最后一段（当前进度），丢掉已经无意义的历史帧
    pushAggLine(sess, buf.slice(-2048).replace(/\r+$/, ''));
    buf = '';
  }
  partials.set(sess.id, buf);
}

function pushAggLine(sess, line) {
  timeline.push({
    sid: sess.id, serverId: sess.serverId, name: sess.name, ip: sess.ip,
    cwd: sess.cwd, text: line
  });
  if (timeline.length > MAX_TIMELINE) timeline.splice(0, timeline.length - MAX_TIMELINE);
  if (state.mode === 'multi' && !state.multiFocus && matchFilter(sess.serverId) && multiHost) {
    writeAggLine(timeline[timeline.length - 1]);
    try { multiHost.term.scrollToBottom(); } catch (_) {}
  }
}

function prefixLabel(e) {
  const label = state.settings.prefixMode === 'ip' ? e.ip : e.name;
  return `${label} - ${shortPath(e.cwd)}`;
}
function shortPath(p) {
  if (!p || p === '/') return '~';
  const parts = String(p).split('/').filter(Boolean);
  if (parts.length <= 2) return '/' + parts.join('/');
  return '…/' + parts.slice(-2).join('/');
}
function writeAggLine(e) {
  const t = multiHost.term;
  if (!t) return;
  const bg = isDark() ? 236 : 254;
  const fg = isDark() ? 250 : 59;
  t.write(`\x1b[48;5;${bg};38;5;${fg}m ${prefixLabel(e)} \x1b[0m ${e.text}\r\n`);
}

function matchFilter(serverId) {
  return state.multiFilter === 'all' || state.multiFilter === serverId;
}

function rebuildAggView() {
  const t = multiTerm();
  if (!t) return;
  // 清视口 + 清回滚（CSI 3J）+ 光标归位，比 reset() 更干净且保留主题状态。
  // 不写入欢迎语：提示已在状态栏与输入框 placeholder 中，且离屏→可见 reflow 时
  // xterm 会把首批 CJK 渲染为占位符，观感差。
  t.write('\x1b[2J\x1b[3J\x1b[H');
  timeline.forEach((e) => { if (matchFilter(e.serverId)) writeAggLine(e); });
  t.scrollToBottom();
}

/* ---------------- 过滤 ---------------- */
export function setMultiFilter(f) {
  state.multiFilter = f;
  state.multiFocus = null;
  renderFilterTabs();
  renderInputPrompt();
  rebuildAggView();
}

export function renderFilterTabs() {
  const tabs = $('#filterTabs');
  if (state.mode !== 'multi') { tabs.innerHTML = ''; return; }
  const frag = document.createDocumentFragment();
  const mk = (key, label) => {
    const b = h('button', `tab${state.multiFilter === key && !state.multiFocus ? ' active' : ''}`, esc(label));
    b.addEventListener('click', () => setMultiFilter(key));
    return b;
  };
  frag.appendChild(mk('all', '全部'));
  state.multiSelected.forEach((sid) => {
    const srv = getServer(sid);
    const live = byServer(sid).some((s) => s.status === 'open');
    if (!srv || !live) return;
    frag.appendChild(mk(sid, srv.name));
  });
  tabs.innerHTML = '';
  tabs.appendChild(frag);
}

/** 多控模式下临时聚焦某台服务器的真实终端（交互式命令用） */
export function focusServerTerm(sess) {
  state.multiFocus = sess?.id || null;
  renderFilterTabs();
  renderInputPrompt();
  if (state.multiFocus) {
    $('#termMulti').hidden = true;
    $('#termWork').hidden = false;
    $('#termEmpty').hidden = true;
    activate(sess.id);
  } else {
    renderMainVisibility();
  }
}

/* ---------------- 选择变化 ---------------- */
export async function onMultiSelectionChanged() {
  // 为没有会话的选中服务器自动建立连接
  for (const sid of state.multiSelected) {
    const live = byServer(sid).filter((s) => s.status === 'open');
    if (!live.length) {
      const srv = getServer(sid);
      if (srv) {
        const { createSession } = await import('./sessions.js');
        await createSession(srv, { silent: true });
      }
    }
  }
  // 清理已取消选择服务器的过滤视图
  if (state.multiFilter !== 'all' && !state.multiSelected.includes(state.multiFilter)) state.multiFilter = 'all';
  renderFilterTabs();
  renderInputPrompt();
  if (state.mode === 'multi' && !state.multiFocus) rebuildAggView();
}

/* ---------------- 多控命令拦截 ----------------
   多控会把同一份输入广播到所有主机。全屏程序、二次交互、持续刷新的命令
   在聚合视图里既看不清也无法逐台操作，密码/确认键还会被一起发出去，
   属于多控无法正确处理的命令：一律不发送，只提示切换到工作台模式执行。
   ------------------------------------------------ */
const FS_CMDS = new Set([
  'vi', 'vim', 'nvim', 'view', 'nano', 'pico', 'emacs', 'joe', 'mc', 'mcedit', 'ranger', 'nnn',
  'top', 'htop', 'atop', 'btop', 'iftop', 'iotop', 'nethogs', 'glances',
  'less', 'more', 'most', 'watch', 'tmux', 'screen', 'alsamixer', 'mutt', 'irssi', 'weechat'
]);

const INTERACTIVE_CMDS = new Set([
  'passwd', 'chpasswd', 'su', 'login', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'expect',
  'mysql', 'mariadb', 'psql', 'sqlite3', 'mongo', 'mongosh', 'redis-cli',
  'fdisk', 'cfdisk', 'parted', 'visudo', 'vipw', 'mkfs'
]);

const PKG_CMDS = new Set(['apt', 'apt-get', 'aptitude', 'yum', 'dnf', 'zypper', 'apk', 'pacman', 'emerge']);
const PKG_VERBS = new Set([
  'install', 'upgrade', 'dist-upgrade', 'full-upgrade', 'remove', 'purge',
  'autoremove', 'update', 'reinstall', 'erase'
]);

const VOLATILE_CMDS = new Set([
  'ps', 'df', 'free', 'w', 'who', 'last', 'lastlog', 'vmstat', 'iostat', 'mpstat', 'pidstat',
  'dmesg', 'ping', 'ping6', 'traceroute', 'tracepath', 'mtr', 'wget', 'curl', 'tcpdump'
]);

const GUARD = {
  fullscreen: {
    label: '全屏交互式程序',
    lead: (name, n) => `${name} 会在 ${n} 台服务器上同时打开全屏界面：清屏和光标跳转会打乱聚合输出，按键也会广播到每一台，无法逐台操作。`,
    advice: '切换到工作台模式后，在左侧逐台切换会话执行；命令会自动填回输入框。'
  },
  interactive: {
    label: '需要二次交互的命令',
    lead: (name, n) => `${name} 执行中会停下来等待输入（确认、密码或编辑器），多控无法同时回应 ${n} 台服务器，容易一起卡在提示符上。`,
    advice: '切换到工作台模式后逐台确认执行；命令会自动填回输入框。'
  },
  volatile: {
    label: '输出不稳定的命令',
    lead: (name, n) => `${name} 的输出随各机状态变化或持续刷新（进度条、滚动日志），聚合后行会被覆盖、错位，无法对比 ${n} 台机器的结果。`,
    advice: '切换到工作台模式后逐台查看，结果更完整可靠；命令会自动填回输入框。'
  }
};

const PREFIX_CMDS = new Set([
  'sudo', 'doas', 'env', 'nohup', 'time', 'command', 'exec', 'nice', 'ionice', 'stdbuf', 'timeout', 'xargs'
]);
const OPTS_WITH_VALUE = new Set(['-u', '-g', '-p', '-U', '-C', '-h', '-r', '-t', '-n', '-c', '-s', '-q']);

/** 去掉 sudo/env/nohup/timeout 等前缀，返回真正被执行的命令与参数 */
function stripPrefixes(tokens) {
  let i = 0;
  while (i < tokens.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) { i++; continue; }
    const base = tokens[i].split('/').pop().toLowerCase();
    if (!PREFIX_CMDS.has(base)) break;
    i++;
    let takeValue = false;
    while (i < tokens.length) {
      const a = tokens[i];
      if (takeValue) { i++; takeValue = false; continue; }
      if (a.startsWith('-')) {
        if (OPTS_WITH_VALUE.has(a.slice(0, 2))) takeValue = true;
        i++;
        continue;
      }
      // timeout/nice/ionice/stdbuf 的第一个非选项参数是数值或信号，跳过
      if (['timeout', 'nice', 'ionice', 'stdbuf'].includes(base)) { i++; continue; }
      break;
    }
  }
  return tokens.slice(i);
}

function firstCommand(seg) {
  const toks = stripPrefixes(seg.trim().split(/\s+/).filter(Boolean));
  if (!toks.length) return null;
  return { cmd: toks[0].split('/').pop().toLowerCase(), args: toks.slice(1) };
}

function riskOf(kind, name) {
  return { kind, name, ...GUARD[kind] };
}

const hasFollow = (args) => args.some((a) => a === '-f' || a === '-F' || a === '--follow' ||
  /^-[A-Za-z]*f[A-Za-z]*$/.test(a));

/** 判断一条命令是否不适合多控执行；返回 { kind, name, label, lead, advice } 或 null */
export function inspectCommand(line) {
  const segs = String(line || '').split(/;|&&|\|\||\||\n/);
  for (const seg of segs) {
    const parsed = firstCommand(seg);
    if (!parsed) {
      // 裸 `sudo` / `su` 会直接进入交互式 shell
      if (/^\s*(sudo|su|doas)\b/.test(seg)) return riskOf('interactive', seg.trim().split(/\s+/)[0]);
      continue;
    }
    const { cmd, args } = parsed;
    const low = args.map((a) => a.toLowerCase());

    if (FS_CMDS.has(cmd)) return riskOf('fullscreen', cmd);
    if (INTERACTIVE_CMDS.has(cmd)) return riskOf('interactive', cmd);

    if (PKG_CMDS.has(cmd)) {
      const verb = low.find((a) => PKG_VERBS.has(a));
      const assumed = low.includes('-y') || low.includes('--yes') || low.includes('--assume-yes') || low.includes('--noconfirm');
      if (verb && !assumed) return riskOf('interactive', `${cmd} ${verb}`);
    }
    if (cmd === 'git' && low[0] === 'rebase' && (low.includes('-i') || low.includes('--interactive'))) {
      return riskOf('interactive', 'git rebase -i');
    }
    if (cmd === 'git' && low[0] === 'commit' && !low.some((a) => a === '-m' || a === '-am' || a === '-ma' || a.startsWith('--message'))) {
      return riskOf('interactive', 'git commit');
    }
    if (cmd === 'crontab' && low.includes('-e')) return riskOf('interactive', 'crontab -e');
    if ((cmd === 'systemctl' || cmd === 'kubectl') && low.includes('edit')) return riskOf('interactive', `${cmd} edit`);

    if (cmd === 'tail' || cmd === 'journalctl') {
      if (hasFollow(args)) return riskOf('volatile', `${cmd} -f`);
      if (cmd === 'journalctl') return riskOf('volatile', cmd);
      continue;
    }
    if ((cmd === 'docker' || cmd === 'kubectl' || cmd === 'podman') && low[0] === 'logs' && hasFollow(args)) {
      return riskOf('volatile', `${cmd} logs -f`);
    }
    if (VOLATILE_CMDS.has(cmd)) {
      // 带 -f 的持续输出更糟；ping / wget / curl 同理
      return riskOf('volatile', cmd);
    }
  }
  return null;
}

function guardModal(line, risk, targets) {
  const n = targets.length;
  const mask = openModal(
    '<div class="guard">' +
      '<div class="guard-top"><span class="guard-ico">' + menuIcon('shield') + '</span>' +
        '<div><div class="guard-tag">' + esc(risk.label) + '</div>' +
        '<div class="guard-sub">多控模式 · 将并发到 ' + n + ' 台服务器</div></div>' +
      '</div>' +
      '<p class="guard-text">' + esc(risk.lead(risk.name, n)) + '</p>' +
      '<div class="guard-cmd"><code>' + esc(line) + '</code></div>' +
      '<p class="guard-advice">' + esc(risk.advice) + '</p>' +
    '</div>' +
    '<div class="m-foot"><span class="guard-foot-hint">命令未发送，多控模式不执行此类命令</span><span class="spacer"></span>' +
      '<button class="btn" id="gdCancel">取消</button>' +
      '<button class="btn primary" id="gdSwitch">切换到工作台模式</button></div>',
    { title: '该命令不适合多控执行' }
  );
  const q = (s) => mask.querySelector(s);
  q('#gdCancel').addEventListener('click', () => mask.close());
  q('#gdSwitch').addEventListener('click', () => {
    mask.close();
    switchMode('workbench');
    const first = targets[0];
    if (first) activate(first.id);
    const inp = $('#cmdInput');
    if (inp) {
      inp.value = line;
      // activate 会在 30ms 后把焦点交给终端，这里稍晚一步抢回来
      setTimeout(() => {
        inp.focus();
        inp.setSelectionRange(line.length, line.length);
      }, 80);
    }
    toast(n > 1
      ? `已切换到工作台模式 · 共 ${n} 台，请在左侧逐台切换后按 Enter 执行`
      : '已切换到工作台模式 · 按 Enter 执行', 'ok', 3800);
  });
}

/* ---------------- 广播执行 ---------------- */
/**
 * 广播一条命令。
 * 返回 true 表示已真正发往服务器；false 表示没有发送（未选服务器 / 被拦截），
 * 调用方据此决定是否清空输入框，避免「命令被拦下但输入也被清掉」。
 * 真正的网络写入在内部异步完成，不阻塞返回值。
 */
export function broadcast(cmd) {
  const line = String(cmd || '').trim();
  if (!line) return false;
  const targets = [];
  state.multiSelected.forEach((sid) => {
    const live = byServer(sid).filter((s) => s.status === 'open');
    if (live.length) targets.push(live[0]);
  });
  if (!targets.length) { toast('请先在左侧勾选服务器（可配合 Shift 连选）', 'warn'); return false; }

  // 多控无法正确处理的命令：直接拦下，不发送，只引导到工作台模式
  if (state.settings.multiGuard !== false && !state.multiFocus) {
    const risk = inspectCommand(line);
    if (risk) {
      guardModal(line, risk, targets);
      return false;
    }
  }

  void sendToAll(targets, line);
  return true;
}

async function sendToAll(targets, line) {
  // 命令回显：写入聚合视图
  if (multiHost && !state.multiFocus) {
    const t = multiHost.term;
    t.write(`\x1b[38;5;81m ❯ ${line}\x1b[0m  \x1b[90m→ ${targets.length} 台服务器\x1b[0m\r\n`);
  }
  // 广播前按各自主机的当前目录预测新 cwd：cd 不会立刻有 OSC7 / ssh-cwd 回来，
  // 不预测的话该主机后续输出行的前缀会停留在旧目录。
  targets.forEach((sess) => noteCommand(sess, line));
  await Promise.all(targets.map((t) => invoke('ssh_write', { sessionId: t.id, data: line + '\n' }).catch(() => {})));
  // 与工作台模式共用同一份历史（含底部历史栏刷新）
  pushHistory(line);
}

/** 关闭会话时清理聚合缓冲 */
export function dropSession(sess) {
  partials.delete(sess.id);
  for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].sid === sess.id) timeline.splice(i, 1);
  if (state.mode === 'multi' && !state.multiFocus) rebuildAggView();
}
