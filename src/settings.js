/**
 * 设置弹窗：外观 / 终端 / 多控 / 连接 / 关于
 */
import { state, persist } from './state.js';
import { invoke } from './api.js';
import { $, esc, toast, openModal, switchHTML } from './ui.js';
import { applyTheme, renderPalette } from './workspace.js';
import { applyWindowMaterial } from './desktop.js';

const FONTS = [
  ['Consolas（Windows 内置）', "Consolas, 'JetBrains Mono', monospace"],
  ['JetBrains Mono', "'JetBrains Mono', Consolas, monospace"],
  ['Cascadia Mono', "'Cascadia Mono', Consolas, monospace"],
  ['Sarasa Mono SC（更纱黑体）', "'Sarasa Mono SC', Consolas, monospace"],
  ['Noto Sans Mono CJK', "'Noto Sans Mono CJK SC', monospace"],
  ['系统等宽', "ui-monospace, SFMono-Regular, Menlo, monospace"]
];

export async function settingsModal() {
  const s = state.settings;
  let info = { version: '1.1.0', platform: '-', ssh: '-' };
  try { info = await invoke('app_info'); } catch (_) {}

  const mask = openModal(
    /* 外观 */
    '<div class="sec"><div class="sec-title">外观</div>' +
    '<div class="row"><div class="r-label"><div class="r-title">深色模式</div><div class="r-desc">深色背景适合长时间排查</div></div>' +
    `<span class="seg" id="setThemeSeg"><button data-v="dark" class="${s.theme !== 'light' ? 'on' : ''}">深色</button><button data-v="light" class="${s.theme === 'light' ? 'on' : ''}">浅色</button></span></div>` +
    '<div class="row"><div class="r-label"><div class="r-title">纯黑背景</div><div class="r-desc">深色模式下终端与面板使用 #000000（OLED 友好）</div></div>' +
    `<span id="setPure">${switchHTML(s.pure)}</span></div>` +
    '<div class="row"><div class="r-label"><div class="r-title">窗口材质</div><div class="r-desc">自动＝Win11 用 Mica，旧系统回退亚克力；嫌拖动卡顿可选纯色</div></div>' +
    `<span class="seg" id="setMaterialSeg">` +
    `<button data-v="auto" class="${(s.material || 'auto') === 'auto' ? 'on' : ''}">自动</button>` +
    `<button data-v="acrylic" class="${s.material === 'acrylic' ? 'on' : ''}">亚克力</button>` +
    `<button data-v="solid" class="${s.material === 'solid' ? 'on' : ''}">纯色</button>` +
    '</span></div>' +
    '</div>' +

    /* 终端 */
    '<div class="sec"><div class="sec-title">终端</div>' +
    '<div class="row"><div class="r-label"><div class="r-title">字体</div></div>' +
    `<select class="select" id="setFont">${FONTS.map(([n, v]) => `<option value="${esc(v)}"${v === s.fontFamily ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div>` +
    `<div class="row"><div class="r-label"><div class="r-title">字号</div></div><input type="range" id="setSize" min="10" max="20" step="1" value="${s.fontSize}"/><span class="range-val" id="setSizeVal">${s.fontSize}px</span></div>` +
    '<div class="row"><div class="r-label"><div class="r-title">缓冲区行数</div><div class="r-desc">终端历史在内存中保留的行数（默认 5000）</div></div>' +
    `<select class="select" id="setBuf">${[1000, 2000, 5000, 10000, 20000, 50000].map((n) => `<option value="${n}"${n === s.bufferLines ? ' selected' : ''}>${n.toLocaleString()} 行</option>`).join('')}</select></div>` +
    '</div>' +

    /* 命令栏 */
    '<div class="sec"><div class="sec-title">命令栏</div>' +
    '<div class="row"><div class="r-label"><div class="r-title">显示快捷命令栏</div><div class="r-desc">固定常用命令，点击即执行；右键标签可编辑 / 删除</div></div>' +
    `<span id="setQuickBar">${switchHTML(s.showQuickBar !== false)}</span></div>` +
    '<div class="row"><div class="r-label"><div class="r-title">显示历史命令栏</div><div class="r-desc">保留最近 20 条执行过的命令，重启后仍在；关闭后仍可用 ↑ / ↓ 翻阅</div></div>' +
    `<span id="setHistBar">${switchHTML(s.showHistoryBar !== false)}</span></div>` +
    '</div>' +

    /* 多控 */
    '<div class="sec"><div class="sec-title">多控</div>' +
    '<div class="row"><div class="r-label"><div class="r-title">输出前缀</div><div class="r-desc">聚合输出中每行前面的服务器标识</div></div>' +
    `<span class="seg" id="setPrefixSeg"><button data-v="name" class="${s.prefixMode !== 'ip' ? 'on' : ''}">服务器名称</button><button data-v="ip" class="${s.prefixMode === 'ip' ? 'on' : ''}">服务器 IP</button></span></div>` +
    '<div class="row"><div class="r-label"><div class="r-title">拦截不适合多控的命令</div><div class="r-desc">vim / top / apt upgrade / wget 等在广播前提示切换到工作台模式</div></div>' +
    `<span id="setGuard">${switchHTML(s.multiGuard !== false)}</span></div>` +
    '</div>' +

    /* 连接 */
    '<div class="sec"><div class="sec-title">连接</div>' +
    '<div class="row"><div class="r-label"><div class="r-title">断线自动重连</div><div class="r-desc">网络抖动导致掉线时，按 0.8s → 12s 指数退避重试，最多 6 次</div></div>' +
    `<span id="setAutoReconnect">${switchHTML(s.autoReconnect !== false)}</span></div>` +
    '<div class="row"><div class="r-label"><div class="r-title">重连后恢复工作目录</div><div class="r-desc">自动切回断线前所在目录（cd 到原路径）</div></div>' +
    `<span id="setRestoreCwd">${switchHTML(s.restoreCwd !== false)}</span></div>` +
    '<div class="row"><div class="r-label"><div class="r-title">提示 tmux / screen 会话</div><div class="r-desc">重连后探测远端 multiplexer，给出 attach 命令以恢复断线前的现场</div></div>' +
    `<span id="setReconnectHint">${switchHTML(s.reconnectHint !== false)}</span></div>` +
    '<div class="row"><div class="r-label"><div class="r-title">代理服务器</div><div class="r-desc">在服务器管理栏空白处右键打开「代理服务器管理」</div></div>' +
    `<span class="sb-item">${state.proxies.length} 个代理</span></div>` +
    '</div>' +

    /* 关于 */
    '<div class="sec"><div class="sec-title">关于</div>' +
    '<div class="about-box"><span class="srv-avatar" style="width:34px;height:34px;border-radius:10px;font-size:13px">LC</span>' +
    `<div><div style="font-size:13px;font-weight:600">LinkConsole</div>` +
    `<div class="r-desc">${esc(info.version)} · ${esc(info.platform)} · SSH: ${esc(info.ssh)}</div></div></div>` +
    '</div>' +

    '<div class="m-foot"><span class="hint">设置即时生效并自动保存</span><span class="spacer"></span><button class="btn primary" data-close>完成</button></div>',
    { title: '偏好设置', wide: true }
  );

  const q = (sel) => mask.querySelector(sel);
  const seg = (sel, cb) => {
    q(sel).querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        q(sel).querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        cb(b.dataset.v);
      }));
  };

  seg('#setThemeSeg', async (v) => { state.settings.theme = v; await persist(); applyTheme(); });
  seg('#setMaterialSeg', async (v) => {
    state.settings.material = v;
    await persist();
    const applied = await applyWindowMaterial();
    const name = { mica: 'Mica（云母）', acrylic: '亚克力', solid: '纯色' }[applied] || applied;
    toast(`窗口材质：${name}`);
  });
  q('#setPure').addEventListener('click', async (e) => {
    if (e.target.closest('button')) return;
    state.settings.pure = !state.settings.pure;
    q('#setPure').innerHTML = switchHTML(state.settings.pure);
    await persist();
    applyTheme();
  });
  q('#setFont').addEventListener('change', async (e) => { state.settings.fontFamily = e.target.value; await persist(); applyTheme(); });  q('#setSize').addEventListener('input', (e) => { q('#setSizeVal').textContent = e.target.value + 'px'; });
  q('#setSize').addEventListener('change', async (e) => { state.settings.fontSize = +e.target.value; await persist(); applyTheme(); });
  q('#setBuf').addEventListener('change', async (e) => { state.settings.bufferLines = +e.target.value; await persist(); applyTheme(); });

  // 开关：默认值为 true，因此按「是否显式为 false」取反，避免 undefined 被当成关闭
  const toggleSwitch = (sel, key) => {
    q(sel).addEventListener('click', async () => {
      const on = state.settings[key] !== false;
      state.settings[key] = !on;
      q(sel).innerHTML = switchHTML(state.settings[key]);
      await persist();
      renderPalette();
    });
  };
  toggleSwitch('#setAutoReconnect', 'autoReconnect');
  toggleSwitch('#setRestoreCwd', 'restoreCwd');
  toggleSwitch('#setReconnectHint', 'reconnectHint');
  toggleSwitch('#setQuickBar', 'showQuickBar');
  toggleSwitch('#setHistBar', 'showHistoryBar');
  seg('#setPrefixSeg', async (v) => { state.settings.prefixMode = v; await persist(); document.dispatchEvent(new CustomEvent('lc-view-changed')); });
  q('#setGuard').addEventListener('click', async () => {
    state.settings.multiGuard = state.settings.multiGuard === false;
    q('#setGuard').innerHTML = switchHTML(state.settings.multiGuard);
    await persist();
  });
  mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
}

export async function aboutModal() {
  let info = { version: '1.1.0', platform: '-', arch: '-', ssh: '-' };
  try { info = await invoke('app_info'); } catch (_) {}
  const mask = openModal(
    '<div class="about-box"><span class="srv-avatar" style="width:46px;height:46px;border-radius:13px;font-size:16px">LC</span>' +
    '<div><div style="font-size:15px;font-weight:650">LinkConsole</div>' +
    `<div class="r-desc">远程连接与管理 Linux 服务器的 Shell 工具</div></div></div>` +
    '<div class="sec"><div class="row"><div class="r-label"><div class="r-title">版本</div></div><span class="sb-item strong">' + esc(info.version) + '</span></div>' +
    '<div class="row"><div class="r-label"><div class="r-title">平台</div></div><span class="sb-item">' + esc(info.platform + ' · ' + info.arch) + '</span></div>' +
    '<div class="row"><div class="r-label"><div class="r-title">SSH 引擎</div></div><span class="sb-item">' + esc(info.ssh) + '</span></div>' +
    '<div class="row"><div class="r-label"><div class="r-title">技术栈</div></div><span class="sb-item">Rust + Tauri 2 + xterm.js</span></div></div>' +
    '<div class="m-foot"><span class="spacer"></span><button class="btn primary" data-close>关闭</button></div>',
    { title: '关于 LinkConsole' }
  );
  mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
}
