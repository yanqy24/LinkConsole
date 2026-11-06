/**
 * 无边框窗口（decorations: false）
 *  - 顶栏空白区域拖动窗口 / 双击切换最大化
 *  - 最小化 / 最大化还原 / 关闭
 * 浏览器预览模式下保留按钮外观但不触发系统行为，便于 UI 校对。
 */
import { IN_TAURI } from './api.js';
import { $, openCtx } from './ui.js';
import { showSnapLayout } from './desktop.js';

let win = null;

export async function initWindowControls() {
  if (!IN_TAURI) return;
  try {
    const mod = await import('@tauri-apps/api/window');
    win = mod.getCurrentWindow();
  } catch (e) {
    console.warn('窗口控制不可用', e);
    return;
  }

  $('#winMin')?.addEventListener('click', () => win.minimize());
  const maxBtn = $('#winMax');
  // 鼠标在最大化按钮上悬停：像资源管理器一样浮出 Win11 贴靠布局
  let snapTimer = null;
  maxBtn?.addEventListener('mouseenter', () => {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => showSnapLayout(), 620);
  });
  maxBtn?.addEventListener('mouseleave', () => clearTimeout(snapTimer));
  maxBtn?.addEventListener('click', async () => {
    clearTimeout(snapTimer);
    await win.toggleMaximize();
    syncMaxState();
  });
  $('#winClose')?.addEventListener('click', () => win.close());

  const bar = $('#titlebar');
  const interactive = (t) => !!t.closest(
    'button, input, select, textarea, .dropdown, .mode-switch, .win-controls, .ctx-menu, .tooltip'
  );

  bar?.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.detail > 1 || interactive(e.target)) return;
    win.startDragging().catch(() => {});
  });
  bar?.addEventListener('dblclick', (e) => {
    if (interactive(e.target)) return;
    win.toggleMaximize().then(syncMaxState).catch(() => {});
  });

  try { await win.onResized(() => syncMaxState()); } catch (_) {}
  syncMaxState();

  // 标题栏右键：系统窗口菜单（还原 / 最小化 / 最大化 / 关闭）
  bar?.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    let maxed = false;
    try { maxed = await win.isMaximized(); } catch (_) {}
    openCtx(e.clientX, e.clientY, [
      { label: '还原', disabled: !maxed, act: () => win.unmaximize().then(syncMaxState).catch(() => {}) },
      { label: '最小化', act: () => win.minimize() },
      { label: maxed ? '向下还原' : '最大化', act: () => win.toggleMaximize().then(syncMaxState) },
      { sep: true },
      { label: '关闭', kbd: 'Alt F4', act: () => win.close() }
    ]);
  });
}

async function syncMaxState() {
  if (!win) return;
  try {
    const maxed = await win.isMaximized();
    const btn = $('#winMax');
    if (!btn) return;
    btn.classList.toggle('maximized', maxed);
    btn.dataset.tip = maxed ? '还原' : '最大化';
    btn.setAttribute('aria-label', maxed ? '还原' : '最大化');
  } catch (_) {}
}
