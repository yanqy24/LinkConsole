/* 通用 UI 工具：DOM / Toast / 弹窗 / 右键菜单 / Tooltip */

import { NATIVE_MENUS, openNativeMenu } from './native-menu.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, cls, html) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtSize = (n) => {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
};

export const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* ---------------- Toast ---------------- */
export function toast(msg, kind = 'info', ms = 2600) {
  const root = $('#toastRoot');
  const el = h('div', `toast ${kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : ''}`,
    `<svg viewBox="0 0 24 24" fill="none">${
      kind === 'ok'
        ? '<path d="M4.5 12.5l4.6 4.6L19.5 6.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        : kind === 'warn'
          ? '<path d="M12 8.6v5.2M12 16.9v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 4.2L2.8 17.4a1.7 1.7 0 001.5 2.6h15.4a1.7 1.7 0 001.5-2.6L13.7 4.2a1.7 1.7 0 00-3 0z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
          : '<circle cx="12" cy="12" r="8.4" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5M12 7.8v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    }</svg><span>${esc(msg)}</span>`);
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ---------------- 弹窗 ---------------- */
export function openModal(bodyHTML, { title, sub, wide, onClose } = {}) {
  const root = $('#modalRoot');
  const mask = h('div', 'backdrop');
  const modal = h('div', `modal${wide ? ' wide' : ''}`);
  modal.innerHTML =
    `<div class="m-head"><div class="m-title">${esc(title || '')}${sub ? `<small>${esc(sub)}</small>` : ''}</div>` +
    `<button class="m-close"><svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>` +
    `<div class="m-body"></div>`;
  modal.querySelector('.m-body').innerHTML = bodyHTML;
  mask.appendChild(modal);
  root.appendChild(mask);
  const close = () => {
    mask.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  modal.querySelector('.m-close').addEventListener('click', close);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  mask.close = close;
  return mask;
}

export const closeModal = (mask) => mask && mask.close && mask.close();

export const switchHTML = (on) =>
  `<span class="switch${on ? ' on' : ''}"></span>`;

/* ---------------- 统一菜单 ----------------
   所有右键菜单与主菜单共用同一套结构与视觉：
   { title, sub, icon }  分组标题（可选副标题）
   { sep: true }         分隔线
   { label, icon, kbd, danger, disabled, checked, act }  菜单项

   桌面端（Tauri）交给系统绘制原生菜单，浏览器预览仍用下面这套 DOM 实现：
   两者共享同一份描述，调用点无需关心跑在哪。
   ------------------------------------------------ */
export const MENU_ICON = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  host: '<rect x="3" y="4.5" width="18" height="6.4" rx="2"/><rect x="3" y="13.1" width="18" height="6.4" rx="2"/><path d="M7 7.7h.01M7 16.3h.01" stroke-width="2.4"/>',
  folder: '<path d="M3.5 7.4a2 2 0 012-2h3.1l1.8 2.2h6.1a2 2 0 012 2v7.8a2 2 0 01-2 2h-11a2 2 0 01-2-2z"/>',
  folderPlus: '<path d="M3.5 7.4a2 2 0 012-2h3.1l1.8 2.2h6.1a2 2 0 012 2v7.8a2 2 0 01-2 2h-11a2 2 0 01-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  proxy: '<path d="M12 3v5M9 6a3 3 0 113 3"/><path d="M5 20.5h14M7 20.5l1.7-6h6.6l1.7 6"/>',
  layers: '<rect x="3" y="3.6" width="8" height="7" rx="1.8"/><rect x="13" y="3.6" width="8" height="7" rx="1.8"/><rect x="3" y="13.4" width="8" height="7" rx="1.8"/><rect x="13" y="13.4" width="8" height="7" rx="1.8"/>',
  terminal: '<rect x="2.7" y="4.2" width="18.6" height="15.6" rx="3.4"/><path d="M7 10.2l3.1 2.4L7 15M12.6 15.2h4.1"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3.2a5.5 5.5 0 01-11 0z"/><path d="M12 16.7v4.3"/>',
  unlink: '<path d="M9.5 14.5l5-5M8 8.5l-1.6 1.6a3.4 3.4 0 004.8 4.8M16 15.5l1.6-1.6a3.4 3.4 0 00-4.8-4.8"/><path d="M4 4l3 3M17 17l3 3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.4"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  paste: '<rect x="5" y="4.5" width="14" height="16" rx="2.4"/><path d="M9 4.5V3h6v1.5M9 11h6M9 15h6"/>',
  pencil: '<path d="M4 20h4l11-11a2.4 2.4 0 00-3.4-3.4L4.6 16.6z"/><path d="M14.5 6.5l3 3"/>',
  trash: '<path d="M5 8h14M9.5 4.8h5M7 8l.8 10.4a1.6 1.6 0 001.6 1.5h5.2a1.6 1.6 0 001.6-1.5L17 8"/><path d="M10.5 11.5v5M13.5 11.5v5"/>',
  refresh: '<path d="M20 12a8 8 0 10-2.6 5.9"/><path d="M20 5.6V12h-6"/>',
  search: '<circle cx="11" cy="11" r="6.4"/><path d="M16 16l4 4"/>',
  clear: '<path d="M5 8h14M9.5 4.8h5M7 8l.8 10.4a1.6 1.6 0 001.6 1.5h5.2a1.6 1.6 0 001.6-1.5L17 8"/>',
  download: '<path d="M12 5v11M7.5 11.5L12 16l4.5-4.5"/><path d="M5 19.5h14"/>',
  upload: '<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5"/><path d="M5 16v2.6A1.6 1.6 0 006.6 20h10.8a1.6 1.6 0 001.6-1.6V16"/>',
  file: '<path d="M6 3.5h7l5 5v12a1 1 0 01-1 1H6a1 1 0 01-1-1v-16a1 1 0 011-1z"/><path d="M13 3.5v5h5"/>',
  check: '<path d="M4.5 12.5l4.6 4.6L19.5 6.8"/>',
  chevronLeft: '<path d="M14 7l-5 5 5 5"/>',
  chevronRight: '<path d="M10 7l5 5-5 5"/>',
  panelLeft: '<rect x="3" y="4.5" width="18" height="15" rx="2.6"/><path d="M9 4.5v15"/>',
  expand: '<path d="M8 4.5H4.5V8M16 4.5h3.5V8M8 19.5H4.5V16M16 19.5h3.5V16"/>',
  collapse: '<path d="M4.5 9H9V4.5M19.5 9H15V4.5M4.5 15H9v4.5M19.5 15H15v4.5"/>',
  settings: '<circle cx="12" cy="12" r="3.1"/><path d="M12 2.8v2.4M12 18.8v2.4M4.5 12H2.1M21.9 12h-2.4M6.4 6.4L4.7 4.7M19.3 19.3l-1.7-1.7M17.6 6.4l1.7-1.7M4.7 19.3l1.7-1.7"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.2M12 7.8v.1" stroke-width="2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.6"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M10 14h8" stroke-width="2"/>',
  command: '<path d="M9 6a2.5 2.5 0 10-2.5 2.5H18a2.5 2.5 0 10-2.5-2.5v12a2.5 2.5 0 102.5-2.5H6.5A2.5 2.5 0 109 18z"/>',
  history: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.2 1.9"/>',
  filter: '<path d="M4 5.5h16l-6.2 7.2v5.3l-3.6 1.8v-7.1z"/>',
  eye: '<path d="M2.6 12S6 6.5 12 6.5 21.4 12 21.4 12 18 17.5 12 17.5 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.6"/>',
  pulse: '<path d="M2.5 12h4l2.2-5.2 3.6 10.4 2.4-5.2h6.8"/>',
  shield: '<path d="M12 3l7.5 3v5.6c0 4.4-3 7.6-7.5 9.4-4.5-1.8-7.5-5-7.5-9.4V6z"/><path d="M9 12l2 2 4-4"/>',
  sort: '<path d="M4 7h12M4 12h9M4 17h6M17 14l3 3 3-3M20 17V5"/>',
  selectAll: '<rect x="4" y="4" width="16" height="16" rx="2.4" stroke-dasharray="3 2.5"/><path d="M8 12h8"/>',
  close: '<path d="M7 7l10 10M17 7L7 17"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  moon: '<path d="M20 14.2A8.4 8.4 0 019.8 4 8.4 8.4 0 1020 14.2z"/>'
};

export const menuIcon = (name) => name && MENU_ICON[name]
  ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${MENU_ICON[name]}</svg>`
  : '<span class="ctx-ico-ph"></span>';

let ctxKeyHandler = null;

export function openCtx(x, y, items) {
  // 桌面端：Win32 原生菜单（系统高亮/阴影/键盘可达，附带加速键提示）
  if (NATIVE_MENUS) {
    closeCtx();
    // 原生菜单偶发弹不出来（窗口非前台、菜单构建失败等）时，
    // 回退到应用内菜单，避免右键之后毫无反应。
    Promise.resolve(openNativeMenu(items)).then((ok) => {
      if (ok === false) renderCtxMenu(x, y, items);
    }).catch(() => renderCtxMenu(x, y, items));
    return;
  }
  renderCtxMenu(x, y, items);
}

function renderCtxMenu(x, y, items) {
  const menu = $('#ctxMenu');
  if (ctxKeyHandler) document.removeEventListener('keydown', ctxKeyHandler, true);
  menu.innerHTML = '';
  menu.classList.remove('hidden');
  menu.hidden = false;

  items.forEach((it) => {
    if (it.sep || it.type === 'sep') {
      menu.appendChild(h('div', 'ctx-sep'));
      return;
    }
    if (it.title || it.type === 'title') {
      const head = h('div', 'ctx-head');
      head.innerHTML =
        (it.icon ? `<span class="ctx-head-ico">${menuIcon(it.icon)}</span>` : '') +
        `<span class="ctx-head-main"><span class="ctx-head-t">${esc(it.title || '')}</span>` +
        (it.sub ? `<span class="ctx-head-s">${esc(it.sub)}</span>` : '') + '</span>';
      menu.appendChild(head);
      return;
    }
    const b = h('button', `ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`);
    b.disabled = !!it.disabled;
    b.innerHTML =
      `<span class="ctx-ico">${it.checked ? menuIcon('check') : menuIcon(it.icon)}</span>` +
      `<span class="ctx-label">${esc(it.label)}</span>` +
      (it.kbd || it.right ? `<span class="ctx-kbd">${esc(it.kbd || it.right)}</span>` : '');
    if (!it.disabled) b.addEventListener('click', () => { closeCtx(); it.act && it.act(); });
    menu.appendChild(b);
  });

  const pad = 8;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.maxHeight = Math.max(160, vh - pad * 2) + 'px';
  const r = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + r.width > vw - pad) left = Math.max(pad, x - r.width);
  if (top + r.height > vh - pad) top = Math.max(pad, y - r.height);
  menu.style.left = Math.max(pad, Math.min(left, vw - r.width - pad)) + 'px';
  menu.style.top = Math.max(pad, Math.min(top, vh - r.height - pad)) + 'px';

  const entries = [...menu.querySelectorAll('.ctx-item:not(.disabled)')];
  let ci = -1;
  const mark = () => entries.forEach((b, i) => b.classList.toggle('sel', i === ci));
  ctxKeyHandler = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      ci = e.key === 'ArrowDown'
        ? (ci + 1) % entries.length
        : (ci - 1 + entries.length) % entries.length;
      mark();
      entries[ci]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && ci >= 0) {
      e.preventDefault(); e.stopPropagation();
      entries[ci].click();
    }
  };
  document.addEventListener('keydown', ctxKeyHandler, true);
}

export function closeCtx() {
  const menu = $('#ctxMenu');
  menu.hidden = true;
  menu.classList.add('hidden');
  if (ctxKeyHandler) {
    document.removeEventListener('keydown', ctxKeyHandler, true);
    ctxKeyHandler = null;
  }
}

/* ---------------- Tooltip ---------------- */
let tipEl = null, tipTimer = null, tipAnchor = null;
export function initTooltip() {
  tipEl = $('#tooltip');
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    // 同一锚点内部移动（按钮 ↔ 内部 SVG）不重置计时，否则气泡永远等不到显示
    if (e.relatedTarget && t.contains(e.relatedTarget)) return;
    if (!tipEl.hidden && tipAnchor === t) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => show(t), 380);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) return;
    // 指针只是从按钮移到其内部的 SVG / 子元素时，mouseout 同样会冒泡上来；
    // 不加 relatedTarget 判断会导致气泡反复隐藏重显示（悬浮闪烁）。
    if (e.relatedTarget && t.contains(e.relatedTarget)) return;
    hide();
  });
  document.addEventListener('mousedown', hide, true);
}

function show(el) {
  const raw = el.dataset.tip || '';
  const [title, sub] = raw.split('|');
  tipAnchor = el;
  tipEl.innerHTML = `<span class="tt-t">${esc(title)}</span>${sub ? `<span style="font-size:10.5px;color:var(--text-faint)">${esc(sub)}</span>` : ''}`;
  tipEl.hidden = false;
  const r = el.getBoundingClientRect();
  const tr = tipEl.getBoundingClientRect();
  let x = r.left + r.width / 2 - tr.width / 2;
  x = Math.max(6, Math.min(x, window.innerWidth - tr.width - 6));
  // 默认显示在锚点下方；放不下再翻到上方，并钳在窗口内（顶部元素不再被屏幕裁掉）
  let y = r.bottom + 8;
  tipEl.classList.remove('above');
  if (y + tr.height > window.innerHeight - 6) {
    y = Math.max(6, r.top - tr.height - 8);
    tipEl.classList.add('above');
  }
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
}
function hide() {
  clearTimeout(tipTimer);
  tipAnchor = null;
  if (tipEl) tipEl.hidden = true;
}

/** 供动态列表在重建子节点前调用：避免气泡钉在已被替换的元素上不消失 */
export function hideTooltip() {
  hide();
}

/* 全局点击：关闭菜单/下拉 */
export function initGlobalDismiss() {
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctxMenu')) closeCtx();
    if (!e.target.closest('.dropdown') && !e.target.closest('#btnMenu')) {
      $('#mainMenu')?.classList.remove('open');
    }
  });
}
