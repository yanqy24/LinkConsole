/**
 * 原生菜单桥（Windows）
 *
 * 应用的右键菜单不再用 HTML div 模拟，而是把同一份菜单描述交给 Rust，
 * 由系统绘制真正的 Win32 菜单：系统级高亮、阴影、圆角、键盘可达性、
 * 触摸/手写笔支持，都与资源管理器、任务栏菜单一致。
 *
 * 调用方仍然写 `openCtx(x, y, items)`，在这里被翻译成原生菜单：
 *   - 每项在弹出瞬间分配一次性 id，点击后由 Rust 通过 `native-menu` 事件回传；
 *   - `title/sub` 这类「表头」在原生菜单里没有对应概念，直接省略
 *     （右键发生在哪一行，上下文本身已经很明显）；
 *   - `kbd` 会被转成系统加速键提示，显示在菜单项右侧。
 */
import { invoke, listen, IN_TAURI } from './api.js';

/** 是否使用原生菜单（浏览器预览时仍然用 HTML 菜单，便于调试与截图） */
export const NATIVE_MENUS = IN_TAURI;

/** id -> 点击回调 */
const handlers = new Map();
let seq = 0;

/** 回调上限：极端情况（菜单反复被打断）下也不让 Map 无限增长 */
const MAX_PENDING = 400;

/** 丢弃某一批的回调 */
function dropBatch(batch) {
  const prefix = `${batch}_`;
  for (const key of [...handlers.keys()]) if (key.startsWith(prefix)) handlers.delete(key);
}

function pruneOldest(keepBatch) {
  if (handlers.size <= MAX_PENDING) return;
  const keep = `${keepBatch}_`;
  for (const key of [...handlers.keys()]) {
    if (handlers.size <= MAX_PENDING / 2) break;
    if (!key.startsWith(keep)) handlers.delete(key);
  }
}

export async function openNativeMenu(items) {
  const batch = `cm${++seq}`;
  // 注意：不能在这里清掉旧批次的回调。
  // 新菜单可能根本弹不出来（窗口非前台等）而回退成 HTML 菜单，此时上一张
  // 原生菜单还挂在屏幕上，提前删掉它的回调会让那一次点击静默失效。
  // 旧批次统一在「新菜单确定弹出成功」之后再清理。

  const spec = [];
  items.forEach((it, i) => {
    if (it.sep || it.type === 'sep') {
      spec.push({ sep: true });
      return;
    }
    if (it.title || it.type === 'title' || !it.label) return;
    const id = `${batch}_${i}`;
    if (!it.disabled && typeof it.act === 'function') handlers.set(id, it.act);
    spec.push({
      id,
      label: it.label,
      kbd: it.kbd || it.right || '',
      disabled: !!it.disabled,
      checked: typeof it.checked === 'boolean' ? it.checked : null
    });
  });
  pruneOldest(batch);

  // 去掉首尾与连续的分隔线，原生菜单里多余的横线很显眼
  const cleaned = [];
  spec.forEach((it) => {
    if (it.sep && (cleaned.length === 0 || cleaned[cleaned.length - 1].sep)) return;
    cleaned.push(it);
  });
  while (cleaned.length && cleaned[cleaned.length - 1].sep) cleaned.pop();
  if (!cleaned.length) return true;

  try {
    // 原生菜单是独立窗口，网页里的悬浮提示要收起来，避免叠在系统菜单上
    document.documentElement.classList.add('native-menu-open');
    await invoke('popup_menu', { items: cleaned });
    // 弹出成功：同一时刻只可能有一张原生菜单，更早的批次已经无从点击。
    // 本批次里没被点到的项（用户按 Esc 关掉菜单）不急着删：点击事件在个别平台
    // 上可能晚于 popup 返回，提前清掉会变成「点了没反应」；残留由 pruneOldest 兜住。
    for (const key of [...handlers.keys()]) {
      if (!key.startsWith(`${batch}_`)) handlers.delete(key);
    }
    return true;
  } catch (e) {
    // 弹不出来就交给调用方回退到应用内菜单：宁可样式差一点，
    // 也不能让用户右键之后什么都不发生。只清本批次，别动屏幕上的旧菜单。
    dropBatch(batch);
    console.warn('原生菜单弹出失败，回退到应用内菜单', e);
    return false;
  } finally {
    document.documentElement.classList.remove('native-menu-open');
  }
}

export function initNativeMenuBridge() {
  if (!IN_TAURI) return;
  listen('native-menu', (id) => {
    const fn = handlers.get(id);
    if (!fn) return;
    handlers.delete(id);
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((e) => console.error(e));
    } catch (e) {
      console.error(e);
    }
  });
}
