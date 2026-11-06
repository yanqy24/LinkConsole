/**
 * 终端核心：xterm.js 宿主、主题、缩略图渲染
 */
import { Terminal } from '@xterm/xterm';
// xterm 自身的 DOM 结构样式（.xterm 定位 / .xterm-viewport 滚动 / helper 覆盖层）。
// 缺了它 viewport 高度会塌成 0：滚轮失效、命中测试偏移、helper 占据顶部空间。
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { state, active } from './state.js';
import { $, openCtx, toast } from './ui.js';

const POOL_W = 1000;
const POOL_H = 640;

/* element → host。用于把「曾经挂到可视容器」的旧宿主安全送回离屏池，
   避免 #termWork 里同时存在多个 .xterm（它们会垂直堆叠、把当前终端挤出可视区）。 */
const hostByEl = new Map();

/** .xterm 元素 → 右键按下瞬间的选区快照（mouseup 可能把选区清掉） */
const ctxSelByEl = new WeakMap();

export function isDark() {
  const html = document.documentElement;
  return html.dataset.theme !== 'light';
}

export function xtermTheme() {
  if (isDark()) {
    return {
      background: '#000000',
      foreground: '#c9d4e3',
      cursor: '#4fd1c5',
      cursorAccent: '#04121a',
      selectionBackground: 'rgba(91,140,255,.32)',
      black: '#1b2028', red: '#f0705f', green: '#4ade80', yellow: '#e8c468',
      blue: '#6aa6ff', magenta: '#c792ea', cyan: '#5eead4', white: '#d6dee9',
      brightBlack: '#5c6773', brightRed: '#ff8a7a', brightGreen: '#7ef0a2',
      brightYellow: '#ffd98a', brightBlue: '#8cbcff', brightMagenta: '#dcb3f5',
      brightCyan: '#8ff0e0', brightWhite: '#ffffff'
    };
  }
  return {
    background: '#ffffff',
    foreground: '#26303b',
    cursor: '#0f9b8e',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(58,110,255,.22)',
    black: '#2b3440', red: '#d24a38', green: '#188038', yellow: '#a86a00',
    blue: '#1a73e8', magenta: '#8430ce', cyan: '#0b7c78', white: '#5c6773',
    brightBlack: '#77828e', brightRed: '#c5221f', brightGreen: '#116e2b',
    brightYellow: '#8a5200', brightBlue: '#1858c4', brightMagenta: '#711ea8',
    brightCyan: '#09636b', brightWhite: '#26303b'
  };
}

export function baseTermOptions() {
  const s = state.settings;
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: 1.25,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    scrollback: Math.max(500, s.bufferLines | 0),
    allowProposedApi: true,
    convertEol: false,
    macOptionIsMeta: true,
    smoothScrollDuration: 60,
    theme: xtermTheme()
  };
}

/** 创建一个 xterm 宿主（先放入离屏池，attach 时再移动 DOM） */
export function createHost({ onData, onResize, onBell } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'pool-wrap';
  wrap.style.width = POOL_W + 'px';
  wrap.style.height = POOL_H + 'px';
  $('#termPool').appendChild(wrap);

  const term = new Terminal(baseTermOptions());
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon());
  term.open(wrap);
  try { fit.fit(); } catch (_) { /* 离屏首次测量失败可忽略 */ }

  // 剪贴板：右键复制选中文本；Ctrl+V / Shift+Insert 粘贴（Ctrl+C 始终是中断信号）
  // 粘贴必须走 term.paste()：它会把文本交给 onData 发给远端，并自动处理
  // bracketed paste 与换行；term.write() 只写显示缓冲，远端收不到任何内容。
  term.attachCustomKeyEventHandler(async (e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;
    if ((ctrl && e.key === 'v') || (e.shiftKey && e.key === 'Insert')) {
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
        const text = await readText();
        if (text) term.paste(text);
      } catch (_) {}
      return false;
    }
    return true;
  });
  // 右键：只记录按下瞬间的选区。
  // 菜单的弹出统一由 desktop.js 在 document 捕获阶段按 `.xterm` 归属分发
  // ——attachHost() 会把 .xterm 从 .pool-wrap 移进 #termWork / #termMulti，
  // 任何挂在 wrap 上的 contextmenu 监听器都会随 DOM 迁移而失效，
  // 那正是「选中文字后右键没反应」的根因（WebView2 默认菜单又已被关闭，
  // 于是既没有应用菜单、也没有系统菜单）。
  term.element.addEventListener('mousedown', (e) => {
    // 右键按下时先记住选区：个别情况下 xterm 会在随后的 mouseup 清掉选区，
    // 到 contextmenu 时 getSelection() 已经为空，菜单项会全部变灰。
    ctxSelByEl.set(term.element, e.button === 2 ? term.getSelection() : '');
  }, true);

  if (onData) term.onData((d) => onData(d));
  if (onResize) term.onResize(({ cols, rows }) => onResize(cols, rows));
  if (onBell) term.onBell(() => onBell());

  // OSC 7：远程 shell 上报 cwd（若启用）
  term.parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (m && term.__cwdHandler) {
      try { term.__cwdHandler(decodeURIComponent(m[1])); } catch (_) {}
    }
    return false;
  });

  const host = {
    term,
    fit,
    search,
    wrap,
    dispose() {
      hostByEl.delete(term.element);
      // element 可能正挂在 #termWork/#termMulti；先摘下来，避免残留空壳 DOM
      const el = term.element;
      if (el && el.parentElement && el.parentElement !== wrap) el.remove();
      term.dispose();
      wrap.remove();
    }
  };
  hostByEl.set(term.element, host);
  return host;
}

/* ---------------- 终端右键菜单 ----------------
   终端元素会被 attachHost() 在「离屏池 ↔ #termWork ↔ #termMulti」之间搬来搬去，
   因此菜单不能挂在某个固定容器上，只能按事件目标反查它当前属于哪个宿主。
   入口在 desktop.js 的 document 捕获阶段统一分发。
   ------------------------------------------ */

/** 由 .xterm 元素（或其子元素）反查宿主的元素根 */
export function hostOfElement(el) {
  const root = el && el.closest ? el.closest('.xterm') : null;
  return root ? hostByEl.get(root) || null : null;
}

/** 终端右键菜单：工作台、多控、侧栏里任何宿主共用同一份 */
export function openTermMenu(host, x, y) {
  const term = host && host.term;
  if (!term) return;
  // 优先取实时选区；若已被 mouseup 清掉，用右键按下时的快照兜底
  const sel = term.getSelection() || ctxSelByEl.get(term.element) || '';
  ctxSelByEl.delete(term.element);
  const writeClip = async (text) => {
    try {
      const c = await import('@tauri-apps/plugin-clipboard-manager');
      await c.writeText(text);
      return true;
    } catch (_) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
    }
  };
  const readClip = async () => {
    try {
      const c = await import('@tauri-apps/plugin-clipboard-manager');
      return (await c.readText()) || '';
    } catch (_) {
      try { return await navigator.clipboard.readText(); } catch (_) { return ''; }
    }
  };
  openCtx(x, y, [
    { title: '终端', sub: sel ? `已选中 ${sel.length} 个字符` : '选中文本后可复制', icon: 'terminal' },
    {
      label: '复制选中文本', icon: 'copy', kbd: '右键', disabled: !sel,
      act: async () => {
        if (!sel) return;
        if (await writeClip(sel)) { term.clearSelection(); toast('已复制到剪贴板'); }
        else toast('复制失败：剪贴板不可用', 'warn');
      }
    },
    {
      label: '粘贴', icon: 'paste', kbd: 'Ctrl V',
      act: async () => {
        const t = await readClip();
        if (t) term.paste(t);
      }
    },
    { label: '全选', icon: 'selectAll', act: () => term.selectAll() },
    { sep: true },
    { label: '清屏', icon: 'clear', act: () => term.clear() },
    { label: '搜索输出…', icon: 'search', act: () => { const i = $('#searchInput'); i?.focus(); i?.select(); } },
    { sep: true },
    { label: '文件管理', icon: 'folder', kbd: 'Ctrl B', act: () => import('./files.js').then((m) => m.toggleFiles()) }
  ]);
}

/**
 * 把宿主挂到可视容器并按容器尺寸重排。
 * 关键：容器里只能有一个宿主。切换会话时把旧宿主的 element 送回它自己的
 * 离屏 .pool-wrap（保持 DOM 存活，xterm 不会因 display:none 而丢失测量），
 * 否则多个 height:100% 的 .xterm 会按文档流上下堆叠，用户看到的永远是最早那个。
 */
export function attachHost(host, container) {
  if (!host || !container) return;
  const el = host.term.element;
  for (const child of Array.from(container.children)) {
    if (child === el) continue;
    const other = hostByEl.get(child);
    if (other && other.wrap && other !== host) other.wrap.appendChild(child);
    else child.remove();
  }
  if (el && el.parentElement !== container) container.appendChild(el);
  requestAnimationFrame(() => {
    try { host.fit.fit(); } catch (_) {}
    try {
      host.term.refresh(0, host.term.rows - 1);
      host.term.scrollToBottom();
    } catch (_) {}
  });
}

/* ---------------- 容器尺寸变化 → 重排可视终端 ----------------
   窗口缩放 / 折叠侧栏 / 开关文件面板都会改变 .term 的尺寸，
   统一交给 ResizeObserver 收敛，避免行数与可视区域脱节。 */
let termRO = null;

/** 重排当前可见的终端宿主（工作台单会话 + 多控聚合视图） */
export function refitVisible() {
  const work = $('#termWork'), multi = $('#termMulti');
  if (work && !work.hidden) {
    const s = active();
    if (s?.host) { try { s.host.fit.fit(); } catch (_) {} }
  }
  if (multi && !multi.hidden) {
    import('./multi.js').then((m) => { try { m.refitMulti(); } catch (_) {} }).catch(() => {});
  }
}

export function observeTermContainer() {
  const box = $('#term');
  if (!box || termRO) return;
  let raf = 0;
  termRO = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(refitVisible);
  });
  termRO.observe(box);
}

/** 宿主是否挂在可视容器里（离屏池里的宿主固定 1000×640，不能拿它的尺寸去 fit） */
function hostAttached(host) {
  const el = host?.term?.element;
  if (!el || !el.isConnected) return false;
  const box = el.closest('#termWork, #termMulti');
  if (!box || box.hidden) return false;
  const r = box.getBoundingClientRect();
  return r.width > 8 && r.height > 8;
}

/** 应用设置变化到所有终端 */
export function applyTermSettings(hosts) {
  const o = baseTermOptions();
  hosts.forEach((h) => {
    const t = h.term;
    t.options.fontFamily = o.fontFamily;
    t.options.fontSize = o.fontSize;
    t.options.theme = o.theme;
    if (t.options.scrollback !== o.scrollback) t.options.scrollback = o.scrollback;
    // 只对「当前可见」的宿主 fit。离屏宿主撑在 1000×640 的池子里（约 160 列），
    // 对它 fit 会把后台会话的 PTY 重置成池子尺寸，远端 top/vim/进度条随之错乱；
    // 切回来时 attachHost 会重新 fit，尺寸自然补上。
    if (hostAttached(h)) {
      try { h.fit.fit(); } catch (_) {}
    } else {
      try { t.refresh(0, t.rows - 1); } catch (_) {}
    }
  });
}

/** 将终端可视区绘制为缩略图（纯 2D canvas，1~2fps 调用） */
export function drawThumb(canvas, host) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 220;
  const hgt = canvas.clientHeight || 124;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = isDark() ? '#000' : '#fff';
  ctx.fillRect(0, 0, w, hgt);

  const buf = host.term.buffer.active;
  const rows = Math.max(4, Math.floor(hgt / 8));
  const startY = Math.max(0, buf.length - rows);
  const fontSize = Math.max(7, Math.min(9, w / 34));
  ctx.font = `${fontSize}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = 'top';
  const lineH = fontSize * 1.35;
  const maxCols = Math.max(10, Math.floor(w / (fontSize * 0.6)));


  for (let r = 0; r < rows; r++) {
    const line = buf.getLine(startY + r);
    if (!line) break;
    let text = '';
    let color = isDark() ? '#8b97a6' : '#5c6773';
    for (let c = 0; c < Math.min(host.term.cols, maxCols * 2); c++) {
      const cell = line.getCell(c);
      if (!cell) break;
      const chars = cell.getChars() || (cell.getWidth() > 0 ? ' ' : '');
      text += chars;
      if (chars.trim()) {
        const mode = cell.getFgColorMode ? cell.getFgColorMode() : 0;
        if (mode === 2) color = '#' + cell.getFgColor().toString(16).padStart(6, '0');
        else if (mode === 1) color = ansiHex(cell.getFgColor());
      }
      if (text.length >= maxCols) break;
    }
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.92;
    ctx.fillText(text.slice(0, maxCols), 4, r * lineH + 3);
  }
  ctx.globalAlpha = 1;
}

function ansiHex(i) {
  const dark = isDark();
  const P = dark
    ? ['#1b2028', '#f0705f', '#4ade80', '#e8c468', '#6aa6ff', '#c792ea', '#5eead4', '#d6dee9']
    : ['#2b3440', '#d24a38', '#188038', '#a86a00', '#1a73e8', '#8430ce', '#0b7c78', '#5c6773'];
  if (i < 8) return P[i];
  if (i >= 8 && i < 16) return P[i - 8];
  return dark ? '#9fb0c0' : '#3c4652';
}
