/**
 * 远程工作目录（cwd）跟踪
 *
 * 背景：后端只在连接建立时用独立 exec 通道上报一次 `pwd`，之后不再推送；
 * 前端原先仅靠 shell 的 OSC 7 更新目录，而 OSC 7 属于可选配置——
 * 没配 PROMPT_COMMAND 的主机 cwd 永远停在初始值，于是多控广播 `cd` 之后，
 * 一部分主机的前缀目录会一直显示旧路径。
 *
 * 这里做三层来源，统一走 setCwd()：
 *   1) 命令预测（最可靠）：我们发出去的 cd 命令自己算新目录，多控广播同样生效；
 *   2) 提示符解析（兜底）：从 PTY 输出末尾的 PS1 里提取绝对路径；PS1 用 `\W`
 *      只显示目录名时无法反推绝对路径，改为一处「可疑」信号触发 pwd 校正；
 *   3) 事件（最高优先级）：OSC 7 与后端 ssh-cwd 上报。
 *
 * 所有路径拼接只允许经过 joinPath()，禁止手写字符串相加，避免出现
 */
import { state } from './state.js';
import { renderStatus, renderInputPrompt } from './workspace.js';
import { invoke } from './api.js';

function homeOf(sess) {
  return sess.user === 'root' ? '/root' : `/home/${sess.user || 'user'}`;
}

/** 规范化绝对路径：折叠 . / .. / 重复斜杠 */
export function normalizeAbs(p) {
  const out = [];
  for (const seg of String(p || '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

/** 取路径最后一段（根目录返回空串） */
function baseName(p) {
  const s = String(p || '').replace(/\/+$/, '');
  if (!s || s === '/') return '';
  return s.slice(s.lastIndexOf('/') + 1);
}

/** 唯一的路径拼接入口：base 与 rel 之间保证且只保证一个分隔符 */
function joinPath(base, rel) {
  const b = String(base || '/').replace(/\/+$/, '') || '';
  const r = String(rel || '').replace(/^\/+/, '');
  if (!r) return b || '/';
  return normalizeAbs(`${b}/${r}`);
}

/** 以会话当前目录为基准解析 cd 参数 */
function resolveCwd(sess, target) {
  const home = homeOf(sess);
  let t = String(target || '').trim();
  if (!t || t === '~') return home;
  if (t.startsWith('~/')) t = joinPath(home, t.slice(2));
  if (t.startsWith('/')) return normalizeAbs(t);
  return joinPath(sess.cwd || home, t);
}

/**
 * 只作为触发校正的信号，不阻止写入（真正的 /application 目录校正后保持不变）。
 */
function looksConcatenated(prev, next) {
  if (!prev || prev === '/') return false;
  const p = String(prev).replace(/\/+$/, '');
  if (!p) return false;
  return next.length > p.length && next.startsWith(p) && next[p.length] !== '/';
}

const verifyTimers = new Map();   // sessionId -> timeout
const verifyAt = new Map();       // sessionId -> 上次校正时间
const VERIFY_MIN_GAP = 1500;      // 同一会话两次校正的最小间隔
const VERIFY_BASE_DELAY = 400;

/**
 * 用独立 exec 通道跑一次 `pwd` 校准 cwd。
 * 只在「提示符与本地记录不一致」或「疑似缺斜杠」时触发，带防抖与限频，
 * 正常操作不会产生额外 SSH 通道。
 */
function scheduleVerify(sess) {
  if (!sess || !sess.id || sess.status !== 'open') return;
  if (verifyTimers.has(sess.id)) return;
  const gap = Date.now() - (verifyAt.get(sess.id) || 0);
  const wait = Math.max(VERIFY_BASE_DELAY, VERIFY_MIN_GAP - gap);
  const timer = setTimeout(async () => {
    verifyTimers.delete(sess.id);
    if (!sess || sess.status !== 'open') return;
    verifyAt.set(sess.id, Date.now());
    try {
      const pwd = await invoke('probe_cwd', { sessionId: sess.id });
      if (typeof pwd === 'string' && pwd.startsWith('/')) setCwd(sess, pwd, 'probe');
    } catch (_) { /* 会话已断开等：忽略 */ }
  }, wait);
  verifyTimers.set(sess.id, timer);
}

/** 统一写入口：任何来源的目录变化都经这里落库并刷新 UI */
export function setCwd(sess, value, source = 'event') {
  if (!sess) return false;
  const raw = String(value || '').trim();
  if (!raw) return false;
  const next = raw.startsWith('/') ? normalizeAbs(raw) : joinPath(sess.cwd || homeOf(sess), raw);
  if (!next) return false;

  // 疑似缺斜杠的脏路径：先落库保证 UI 立刻有反馈，同时异步 pwd 校正
  if (source !== 'probe' && looksConcatenated(sess.cwd, next)) scheduleVerify(sess);

  if (next === sess.cwd) return false;
  sess.cwd = next;
  if (state.activeId === sess.id) renderStatus();
  if (state.mode === 'multi') renderInputPrompt();
  return true;
}

/**
 * 命令预测：发送一行命令前调用。
 * 支持复合命令里的 cd（`cd /a && tail -f x`、`cd /a; pwd`、`cd /a | cat`）。
 */
export function noteCommand(sess, line) {
  const cmd = String(line || '').trim();
  if (!cmd) return false;
  // 记录最近一次执行的命令（会话卡片「最新命令」用）
  sess.lastCmd = cmd;
  let changed = false;
  for (const part of cmd.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    const m = /^(?:sudo\s+)?cd(?:\s+(.*))?$/.exec(part.trim());
    if (!m) continue;
    const arg = (m[1] || '').trim().replace(/^(['"])(.*)\1$/, '$2');
    let next;
    if (arg === '-') {
      if (!sess.prevCwd) continue;
      next = sess.prevCwd;
    } else {
      next = resolveCwd(sess, arg);
    }
    if (next && next !== sess.cwd) {
      sess.prevCwd = sess.cwd;
      changed = setCwd(sess, next, 'predict') || changed;
    }
  }
  return changed;
}

/**
 * 终端键盘输入 → 组装整行命令。
 * 与 trackHistory 解耦：多控模式下非活动终端、以及没走输入框的键入也要能预测。
 *
 * Tab 补全 / ↑↓ 历史的「补全回显」不会经过输入流（ onData ），本地组装的行
 * 这类行标记 tainted：跳过 cwd 预测、由 sessions.js 的「回显重建」在命令回显
 * 出现后用完整命令修正 lastCmd / 历史与目录。
 */
export function noteInput(sess, d) {
  if (d === '\r' || d === '\n') {
    const line = (sess.__inputLine || '').trim();
    const tainted = !!sess.__inputTainted;
    sess.__inputLine = '';
    sess.__inputTainted = false;
    if (line || tainted) {
      if (tainted) {
        // 行不完整（补全 / 历史回显不经过输入流）：不做 cwd 预测，
        // 由 sessions.js 在回车时读取终端缓冲区拿到完整命令后再预测
        sess.lastCmd = line;
        if (sess.pv) sess.pv.dirty = true;
      } else {
        noteCommand(sess, line);
      }
    }
    return;
  }
  if (d === '\x7f' || d === '\b') { sess.__inputLine = (sess.__inputLine || '').slice(0, -1); return; }
  if (d === '\x15') { sess.__inputLine = ''; sess.__inputTainted = true; return; }   // Ctrl+U 清空当前行
  if (d === '\x03' || d === '\x04') { sess.__inputLine = ''; sess.__inputTainted = false; return; } // Ctrl+C / Ctrl+D
  if (d === '\t') { sess.__inputTainted = true; return; }   // Tab：远程 shell 将补全并回显
  // 粘贴会一次性送来整串（可能自带换行）：按行拆分，最后一段留作当前行
  if (d.length > 1) {
    if (d.includes('\x1b')) { sess.__inputTainted = true; return; }   // 括号粘贴 / 按键序列
    const clean = String(d).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (!/^[\x20-\x7e\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef\r\n]*$/.test(clean)) return;
    const lines = clean.split(/\r\n|\r|\n/);
    const tail = lines.pop() ?? '';
    lines.forEach((ln) => {
      const line = (ln || '').trim();
      if (line) noteCommand(sess, line);
    });
    sess.__inputLine = (tail || '').slice(-400);
    return;
  }
  if (d.charCodeAt(0) < 32) {
    if (d === '\x1b') sess.__inputTainted = true;   // ESC：↑↓ 历史 / Home 等会重绘整行
    return;                                          // 其余控制字符（Tab 已在上面处理）
  }
  sess.__inputLine = ((sess.__inputLine || '') + d).slice(-400);
}

export function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')             // CSI
    .replace(/\x1b[@-_]/g, '');                          // 双字符 ESC 序列
}

/**
 * 提示符解析：只看输出流最后一行（PS1 不带换行）。
 * 返回 { abs } / { home } / { rel } / { name }，无可用信息返回 null。
 *
 * 支持：`[root@h /root/logs]# `、`root@h:/root/logs$ `、`/root/logs # `、
 *       `[root@h ~]# `、`[root@h ~/logs]$ `、`[root@h logs]# `（\W 短名）。
 */
function parsePrompt(last) {
  // user@host:/abs/path$
  const colon = /:(\/[^\s#$>%]*)\s*[#$>%]\s*$/.exec(last);
  if (colon) return { abs: colon[1] };

  // 以绝对路径结尾：[user@host /abs]# 、 /abs #
  const toks = last.trim().split(/\s+/);
  for (let i = toks.length - 1; i >= 0; i--) {
    const tk = toks[i].replace(/[^\w.~/*-]+$/g, '');
    if (tk.length > 1 && tk.startsWith('/') && /^\/[\w.~/*-]+$/.test(tk)) return { abs: tk };
  }

  // `\W` 短名 / `~`：只有看着像 PS1 的行才处理，避免把普通输出当提示符
  if (!/[@\[]/.test(last)) return null;
  const raw = toks[toks.length - 1] || '';
  const cand = raw.replace(/[^A-Za-z0-9._@+~/-]+$/g, '');
  if (!cand || cand.includes('@')) return null;
  if (cand === '~') return { home: true };
  if (cand.startsWith('~/')) return { rel: cand };
  if (cand.startsWith('/')) return null;
  return { name: cand };
}

/**
 * 提示符解析：只看输出流最后一行（PS1 不带换行）。
 * 绝对路径视为权威来源；`\W` 短名与本地记录不一致时触发 pwd 校正。
 */
export function noteOutput(sess, data) {
  const clean = stripAnsi(String(data)).replace(/\r/g, '');
  const cut = clean.lastIndexOf('\n');
  const last = clean.slice(cut + 1);
  if (!last || !/[#$>%]\s*$/.test(last)) return;
  const tail = last.slice(-180);

  const r = parsePrompt(tail);
  if (!r) return;
  if (r.abs) {
    const next = normalizeAbs(r.abs);
    if (next && next !== sess.cwd) {
      sess.prevCwd = sess.cwd;
      setCwd(sess, next, 'prompt');
    }
    return;
  }
  if (r.home) { setCwd(sess, homeOf(sess), 'prompt'); return; }
  if (r.rel) { setCwd(sess, joinPath(homeOf(sess), r.rel.slice(2)), 'prompt'); return; }
  if (r.name && r.name !== baseName(sess.cwd)) scheduleVerify(sess);
}
