/**
 * 桌面化行为层：抹掉 WebView 的「网页感」。
 *
 *  - 屏蔽浏览器加速键（打印/下载/另存/查看源码/查找/缩放/后退…）
 *  - 右键在输入框、可编辑区弹出系统编辑菜单（撤销/剪切/复制/粘贴/全选）
 *  - 阻止图片、链接拖拽与中键新窗口，避免把桌面程序用成浏览器
 *  - 窗口材质（Mica / 亚克力 / 纯色）与 Win11 贴靠布局
 */
import { state } from './state.js';
import { invoke, IN_TAURI } from './api.js';
import { $, openCtx, toast } from './ui.js';
import { hostOfElement, openTermMenu } from './term.js';

/* ---------------- 剪贴板 ---------------- */
async function clipMod() {
  if (!IN_TAURI) return null;
  return import('@tauri-apps/plugin-clipboard-manager').catch(() => null);
}

async function readClip() {
  const m = await clipMod();
  if (m) return (await m.readText().catch(() => '')) || '';
  try { return await navigator.clipboard.readText(); } catch (_) { return ''; }
}

async function writeClip(text) {
  const m = await clipMod();
  if (m) { try { await m.writeText(text); return true; } catch (_) { return false; } }
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
}

/** 供其他模块复用的剪贴板写入（Tauri 插件优先，浏览器回退） */
export const copyText = (text) => writeClip(String(text ?? ''));

/* ---------------- 可编辑区识别 ---------------- */
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number']);

function editableOf(el) {
  if (!el || !el.closest) return null;
  // 终端内部有隐藏 textarea，但它的编辑语义由 xterm 自己的菜单负责
  if (el.closest('.xterm')) return null;
  const ed = el.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
  if (!ed) return null;
  if (ed.tagName === 'INPUT' && !TEXT_INPUT_TYPES.has((ed.type || '').toLowerCase())) return null;
  if (ed.disabled || ed.readOnly) return null;
  return ed;
}

function isField(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

/** 取当前被选中的文本（输入框取 value 片段，普通区域取 DOM 选区） */
function selectedText(el) {
  if (isField(el)) {
    const { selectionStart: a, selectionEnd: b } = el;
    if (typeof a === 'number' && typeof b === 'number' && b > a) return el.value.slice(a, b);
    return '';
  }
  const sel = window.getSelection();
  return sel ? String(sel) : '';
}

function replaceSelection(el, text) {
  if (isField(el)) {
    const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
    el.focus();
    if (typeof el.setRangeText === 'function') {
      el.setRangeText(text, start, end, 'end');
    } else {
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  el.focus();
  document.execCommand('insertText', false, text);
}

/* ---------------- 系统编辑菜单 ---------------- */
function openEditMenu(el) {
  const hasSel = selectedText(el).length > 0;
  openCtx(0, 0, [
    { label: '撤销', kbd: 'Ctrl Z', act: () => document.execCommand('undo') },
    { label: '重做', kbd: 'Ctrl Y', act: () => document.execCommand('redo') },
    { sep: true },
    {
      label: '剪切', kbd: 'Ctrl X', disabled: !hasSel,
      act: async () => {
        const text = selectedText(el);
        if (!text) return;
        if (await writeClip(text)) replaceSelection(el, '');
      }
    },
    {
      label: '复制', kbd: 'Ctrl C', disabled: !hasSel,
      act: async () => {
        const text = selectedText(el);
        if (text && await writeClip(text)) toast('已复制');
      }
    },
    {
      label: '粘贴', kbd: 'Ctrl V',
      act: async () => {
        const text = await readClip();
        if (text) replaceSelection(el, text);
      }
    },
    { sep: true },
    {
      label: '全选', kbd: 'Ctrl A',
      act: () => {
        if (typeof el.select === 'function') el.select();
        else document.execCommand('selectAll');
      }
    }
  ]);
}

/** 普通区域有选中文本时的精简菜单 */
function openSelectionMenu(text) {
  openCtx(0, 0, [
    { label: '复制', kbd: 'Ctrl C', act: async () => { if (await writeClip(text)) toast('已复制'); } },
    { label: '全选', kbd: 'Ctrl A', act: () => document.execCommand('selectAll') }
  ]);
}

/* ---------------- 快捷键 / 拖拽 / 右键 ---------------- */
const DEV = import.meta.env && import.meta.env.DEV;

function block(e) {
  e.preventDefault();
  e.stopPropagation();
  return false;
}

export function initDesktopBehavior() {
  // 1) 浏览器加速键：全部交给应用自己定义。
  //    终端区域例外——Ctrl+R/Ctrl+P/Ctrl+S… 在 shell 里有 readline 语义，
  //    必须原样送达远程 shell；WebView2 的浏览器加速键已在 Rust 侧关闭，
  //    这里只负责非终端区域的兜底。
  document.addEventListener('keydown', (e) => {
    const inTerm = e.target.closest && e.target.closest('.xterm');
    if (inTerm) return undefined;

    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    // 查找：转成应用内的输出搜索
    if (ctrl && !e.shiftKey && k === 'f') {
      const input = $('#searchInput');
      if (input) { input.focus(); input.select(); }
      return block(e);
    }
    // 设备调试键（开发模式下保留，方便排查）
    const devKey = e.key === 'F12' || (ctrl && e.shiftKey && (k === 'i' || k === 'j' || k === 'c'));
    if (devKey) {
      if (DEV) return undefined;
      return block(e);
    }
    // 打印 / 下载 / 另存 / 打开 / 查看源码 / 刷新 / 关闭标签
    if (ctrl && !e.shiftKey && ['p', 'j', 's', 'o', 'u', 'r', 'w'].includes(k)) return block(e);
    // 网页缩放：桌面程序的字号由设置决定，不接受浏览器缩放
    if (ctrl && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) return block(e);
    // F3 查找、F5 刷新、F7 光标浏览
    if (e.key === 'F3' || e.key === 'F5' || e.key === 'F7') return block(e);
    // Alt+←/→ 历史后退前进
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return block(e);
    return undefined;
  }, true);

  // Ctrl+滚轮缩放
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  // 2) 拖拽：图片、链接不产生拖影，外部文件交给 Tauri 的 webview 级拖放
  document.addEventListener('dragstart', (e) => {
    if (e.target.closest && e.target.closest('a, img, .srv-avatar')) e.preventDefault();
  }, true);
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // 中键点击链接不开新窗口
  document.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  document.addEventListener('mousedown', (e) => {
    if (e.button === 1 && e.target.closest && e.target.closest('a')) e.preventDefault();
  });

  // 3) 右键：终端 → 终端菜单；输入框 → 系统编辑菜单；其余交给业务菜单
  document.addEventListener('contextmenu', (e) => {
    // 终端优先：.xterm 会被搬到不同容器，只有按元素归属查宿主才稳。
    // 之前终端自己在 .pool-wrap 上监听，attachHost 把 .xterm 移走后监听即失效，
    // 表现为「选中文字后右键没反应」（系统菜单已在 Rust 侧关闭，所以什么都没有）。
    const inTerm = e.target.closest && e.target.closest('.xterm');
    if (inTerm) {
      e.preventDefault();
      e.stopPropagation();
      const host = hostOfElement(inTerm);
      if (host) openTermMenu(host, e.clientX, e.clientY);
      return;
    }
    const ed = editableOf(e.target);
    if (ed) {
      e.preventDefault();
      e.stopPropagation();
      openEditMenu(ed);
      return;
    }
    // 落在终端容器的内边距 / 空白处（严格来说不在 .xterm 上）：同样给终端菜单，
    // 否则用户差一两个像素就会觉得「右键没反应」。
    const area = e.target.closest && e.target.closest('#term');
    if (area) {
      const holder = [...area.querySelectorAll('.term-host')]
        .find((h) => !h.hidden && h.querySelector('.xterm'));
      const host = holder ? hostOfElement(holder.querySelector('.xterm')) : null;
      if (host) {
        e.preventDefault();
        e.stopPropagation();
        openTermMenu(host, e.clientX, e.clientY);
        return;
      }
    }
    const sel = String(window.getSelection() || '');
    if (sel.trim()) {
      e.preventDefault();
      e.stopPropagation();
      openSelectionMenu(sel);
      return;
    }
    // 业务菜单会自己 preventDefault；这里兜底，避免任何情况下弹出网页菜单
    e.preventDefault();
  }, true);
}

/* ---------------- 窗口材质 ---------------- */
export async function applyWindowMaterial() {
  if (!IN_TAURI) return 'solid';
  const material = state.settings.material || 'auto';
  const dark = state.settings.theme !== 'light';
  try {
    const applied = await invoke('set_window_material', { material, dark });
    document.documentElement.dataset.material = applied;
    return applied;
  } catch (e) {
    console.warn('窗口材质设置失败', e);
    document.documentElement.dataset.material = 'solid';
    return 'solid';
  }
}

/** Win11 贴靠布局：由 decorum 插件唤起系统浮层（与资源管理器最大化按钮一致） */
export function showSnapLayout() {
  if (!IN_TAURI) return;
  invoke('plugin:decorum|show_snap_overlay').catch(() => {});
}
