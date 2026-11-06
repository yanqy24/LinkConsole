/**
 * LinkConsole 前端入口
 */
import './theme.css';
import { state, loadConfig, byId, byServer, getServer, persist } from './state.js';
import { invoke, listen, IN_TAURI } from './api.js';
import { $, toast, initTooltip, initGlobalDismiss } from './ui.js';
import { createSession, activate, renderMainVisibility, renderSessionList, startPreviewLoop, closeSession, pushHistory, initSessionColumn, onSessionData, onSessionCwd, onSessionClosed } from './sessions.js';
import { attachMultiView, renderFilterTabs, ensureMultiHost, broadcast } from './multi.js';
import { renderStatus, renderPalette, renderInputPrompt, applyTheme, switchMode, positionGlider, initWorkspace, applyComplete, completeVisible } from './workspace.js';
import { initServers, renderServerTree } from './servers.js';
import { initFiles, onTransferProgress } from './files.js';
import { initWindowControls } from './window.js';
import { initDesktopBehavior } from './desktop.js';
import { initNativeMenuBridge } from './native-menu.js';
import { observeTermContainer } from './term.js';

async function boot() {
  // 1. 配置
  try {
    const cfg = await invoke('store_load');
    loadConfig(cfg);
  } catch (e) {
    console.warn('配置加载失败，使用默认', e);
  }
  // 全新安装保持空白：不预置任何主机、分组、代理或快捷命令

  // 2. 静态 UI
  initTooltip();
  initGlobalDismiss();
  initNativeMenuBridge();
  initDesktopBehavior();
  initWindowControls();
  initWorkspace();
  initServers();
  initSessionColumn();
  initFiles();
  observeTermContainer();
  applyTheme();
  renderServerTree();
  renderSessionList();
  renderStatus();
  renderPalette();
  renderInputPrompt();
  positionGlider();
  startPreviewLoop();
  bindDataEvents();
  await bindDragDrop();

  // 3. 启动后动作
  setTimeout(() => positionGlider(), 60);
  if (IN_TAURI) {
    toast('欢迎使用 LinkConsole · 在左侧新建主机开始', 'ok', 3400);
  } else {
    toast('浏览器预览模式 · 界面可交互，不连接真实主机', 'warn', 3800);
  }
  await runDemoParams();
}

/** 仅无头验证 / 演示用的 URL 参数：临时内存数据，绝不写入配置 */
async function runDemoParams() {
  const q = new URLSearchParams(location.search);
  const demo = q.get('demo') || '';
  if (q.get('theme') === 'light') {
    state.settings.theme = 'light';
    import('./workspace.js').then((m) => m.applyTheme());
  }
  if (!demo) return;
  if (!state.servers.length) {
    const names = [
      ['Web01', '192.0.2.10'], ['Web02', '192.0.2.11'], ['DB01', '192.0.2.20']
    ];
    state.servers = names.slice(0, demo.includes('three') ? 3 : 2).map(([name, ip], i) => ({
      id: 'demo-' + i, name, ip, port: 22, user: 'root', group: '演示分组',
      auth: 'password', password: '', key_path: '', proxy_id: '', os: 'Linux', __demo: true
    }));
    state.groups = ['演示分组'];
    const { renderServerTree } = await import('./servers.js');
    renderServerTree();
  }
  const { createSession } = await import('./sessions.js');
  if (demo.includes('sessions') || demo.includes('multi')) {
    const targets = state.servers.slice(0, demo.includes('three') ? 3 : 2);
    for (const srv of targets) await createSession(srv, { silent: true });
  }
  // 会话预览演示：向每个会话发送一条代表性命令，用于核对卡片预览效果
  if (demo.includes('preview')) {
    const { noteCommand } = await import('./cwd.js');
    const { pushHistory } = await import('./sessions.js');
    // 用带绝对路径的命令验证「斜杠在预览与历史栏中完整显示」
    const cmds = ['cd /app/api && pwd', 'tail -n 20 /var/log/nginx/access.log', 'df -h /data'];
    await new Promise((r) => setTimeout(r, 400));
    for (let i = 0; i < state.sessions.length; i++) {
      const s = state.sessions[i];
      const cmd = cmds[i % cmds.length];
      noteCommand(s, cmd);
      pushHistory(cmd);
      try { await invoke('ssh_write', { sessionId: s.id, data: cmd + '\n' }); } catch (_) {}
    }
  }
  // 命令重建演示：走真实键盘链路键入 `cd /ap<Tab><Enter>`，
  // 验证预览顶部与历史栏显示的是屏幕上的完整命令（cd /app/）而不是补全前的前缀
  if (demo.includes('echo')) {
    await new Promise((r) => setTimeout(r, 700));
    const s = state.sessions[0];
    if (s && s.host) {
      const type = async (str) => {
        for (const ch of str) {
          s.host.term.input(ch);
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      await type('cd /ap');
      s.host.term.input('\t');
      await new Promise((r) => setTimeout(r, 180));
      s.host.term.input('\r');
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (demo.includes('multi')) {
    const { switchMode } = await import('./workspace.js');
    state.multiSelected = state.servers.slice(0, demo.includes('three') ? 3 : 2).map((s) => s.id);
    switchMode('multi');
    const { broadcast } = await import('./multi.js');
    setTimeout(() => broadcast('uptime'), 600);
  }
  if (demo.includes('ctx')) {
    const { openCtx } = await import('./ui.js');
    setTimeout(() => openCtx(300, 210, [
      { title: 'Web01', sub: '192.0.2.10:22 · Ubuntu 22.04', icon: 'host' },
      { label: '新建会话', icon: 'terminal', kbd: '双击', act: () => {} },
      { label: '多控本组服务器', icon: 'layers', act: () => {} },
      { label: '测试连接（禁用态示例）', icon: 'pulse', disabled: true },
      { sep: true },
      { label: '编辑主机', icon: 'pencil', act: () => {} },
      { label: '复制主机', icon: 'copy', act: () => {} },
      { sep: true },
      { label: '删除主机', icon: 'trash', danger: true, act: () => {} }
    ]), 500);
  }
  if (demo.includes('menu')) {
    setTimeout(() => $('#mainMenu')?.classList.add('open'), 400);
  }
  // 传输队列演示：打开文件面板并排入两个任务（浏览器预览下由 mock 后端产生进度）
  if (demo.includes('sftp')) {
    const f = await import('./files.js');
    await f.openFiles();
    await f.uploadTo(['C:////demo////release.tar.gz'], '/');
    await f.uploadTo(['C:////demo////access.log'], '/var/log');
  }

  /* ---------------- README 截图场景（无头渲染专用，纯内存态，不写配置） ---------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 工作台模式：3 个会话各跑代表性命令，卡片预览 + 未读点 + 快捷命令栏
  if (demo.includes('wshot')) {
    for (const srv of state.servers) await createSession(srv, { silent: true });
    const { noteCommand } = await import('./cwd.js');
    const { pushHistory, activate } = await import('./sessions.js');
    await sleep(800);
    const run = async (s, cmd) => {
      noteCommand(s, cmd);
      pushHistory(cmd);
      await invoke('ssh_write', { sessionId: s.id, data: cmd + '\n' });
      await sleep(280);
    };
    const [w1, w2, db] = state.sessions;
    await run(w1, 'cd /var/log');
    await run(w1, 'docker ps');
    await run(w1, 'df -h /data');
    await run(w2, 'cd /var/log/nginx');
    await run(w2, 'tail -n 5 /var/log/nginx/error.log');
    await run(db, 'free -m');
    activate(w1.id);
    state.quickCommands = [
      { label: 'df -h', cmd: 'df -h' },
      { label: 'docker ps', cmd: 'docker ps' },
      { label: 'nginx 错误日志', cmd: 'tail -n 50 /var/log/nginx/error.log' },
    ];
    const { renderPalette } = await import('./workspace.js');
    renderPalette();
    await sleep(600);
    // 非活动卡片产生「未读」提示点
    await invoke('ssh_write', { sessionId: db.id, data: 'uptime\n' });
    await sleep(700);
  }
  // 多控模式：聚合视图直接注入两轮统计命令的输出（wc -l 行数 + grep -c 5xx 次数）
  if (demo.includes('mshot')) {
    for (const srv of state.servers) await createSession(srv, { silent: true });
    const { switchMode } = await import('./workspace.js');
    const { ensureMultiHost, clearAggregate, feedMulti } = await import('./multi.js');
    const { pushHistory } = await import('./sessions.js');
    await sleep(800);
    for (const s of state.sessions) s.cwd = '/var/log';
    state.multiSelected = state.servers.map((s) => s.id);
    switchMode('multi');
    await sleep(500);
    clearAggregate();
    const t = ensureMultiHost().term;
    const rounds = [
      ['wc -l /var/log/nginx/access.log', { Web01: 1284503, Web02: 1197882, DB01: 96338 }, (n) => `${n} /var/log/nginx/access.log`],
      ["grep -c ' 500 ' /var/log/nginx/access.log", { Web01: 2314, Web02: 2089, DB01: 178 }, (n) => `${n} /var/log/nginx/access.log`],
    ];
    for (const [cmd, counts, fmt] of rounds) {
      pushHistory(cmd);
      t.write(`\x1b[38;5;81m ❯ ${cmd}\x1b[0m  \x1b[90m→ 3 台服务器\x1b[0m\r\n`);
      await sleep(120);
      for (const s of state.sessions) {
        feedMulti(s, fmt(counts[s.name]) + '\r\n');
        await sleep(90);
      }
      await sleep(150);
    }
    await sleep(500);
  }
  // 文件管理：/var/log/nginx 目录 + 四态传输队列（完成 / 运行中 / 暂停续传 / 排队）
  if (demo.includes('fshot')) {
    await createSession(state.servers[0], { silent: true });
    const f = await import('./files.js');
    await sleep(700);
    await invoke('ssh_write', { sessionId: state.sessions[0].id, data: 'cd /var/log/nginx\n' });
    await sleep(200);
    await invoke('ssh_write', { sessionId: state.sessions[0].id, data: 'ls -lh\n' });
    await f.openAt('/var/log/nginx');
    await sleep(500);
    const MB = 1024 * 1024;
    const names = ['static-assets.zip', 'demo-release.tar.gz', 'demo-service.jar', 'nginx.conf.bak'];
    await f.uploadTo([
      'C:/Users/demo/Deploy/' + names[0],
      'C:/Users/demo/Deploy/' + names[1],
      'C:/Users/demo/Deploy/' + names[2],
      'C:/Users/demo/Deploy/' + names[3],
    ], '/srv/demo/deploy');
    await sleep(200);
    const ids = [...document.querySelectorAll('#trList .tr-row')].map((el) => el.dataset.id);
    if (ids.length >= 4) {
      // ① 已完成（串行队列里最先跑完的小文件）：先冻结 mock 计时器，防止其自带的
      //    8MB done 事件稍后回来覆盖合成进度（完成 · 8.0 MB 的竞态）
      try { await invoke('sftp_pause_transfer', { transferId: ids[0] }); } catch (_) {}
      f.onTransferProgress({ transferId: ids[0], name: names[0], total: 46.2 * MB, transferred: 46.2 * MB, state: 'running' });
      f.onTransferProgress({ transferId: ids[0], name: names[0], state: 'done' });
      await sleep(200);
      // ② 运行中：冻结 mock 计时器，用合成进度事件给出稳定速率（~12.4 MB/s）与剩余时间
      try { await invoke('sftp_pause_transfer', { transferId: ids[1] }); } catch (_) {}
      await sleep(3000);
      f.onTransferProgress({ transferId: ids[1], name: names[1], total: 430 * MB, transferred: 37.2 * MB, state: 'running' });
      await sleep(19000);
      f.onTransferProgress({ transferId: ids[1], name: names[1], total: 430 * MB, transferred: 272.8 * MB, state: 'running' });
      // ③ 已暂停 + 断点续传信息
      f.onTransferProgress({ transferId: ids[2], name: names[2], total: 512 * MB, transferred: 210 * MB, resumedFrom: 96.3 * MB, state: 'running' });
      f.onTransferProgress({ transferId: ids[2], name: names[2], state: 'paused' });
      await sleep(400);
    }
  }

}

/* ---------------- 后端事件 ---------------- */
function bindDataEvents() {
  // 连接窗口期（ssh_connect 尚未返回 id）先到的数据由 sessions.js 暂存并回放
  listen('ssh-data', ({ id, data }) => onSessionData(id, data));
  listen('ssh-cwd', ({ id, data }) => onSessionCwd(id, data));
  listen('ssh-closed', ({ id, reason }) => onSessionClosed(id, reason));

  // 传输进度：文件面板的传输条按 transferId 实时刷新百分比
  listen('sftp-progress', (p) => onTransferProgress(p));
}

/* ---------------- 拖拽（Tauri webview 级） ---------------- */
async function bindDragDrop() {
  if (!IN_TAURI) return;
  // 由 files.js 处理文件面板内的拖拽；这里兜底：拖到终端区域 = 上传到当前目录
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().onDragDropEvent((event) => {
      const t = event.payload.type;
      if (t === 'drop' && state.files.open) return; // 文件面板已处理
      if (t === 'drop' && (event.payload.paths || []).length) {
        const s = byId(state.activeId);
        if (!s) return;
        const paths = event.payload.paths;
        import('./files.js').then(async (f) => {
          await f.openFiles();
          await f.uploadTo(paths, s.cwd || '/');
        });
      }
    });
  } catch (_) {}
}

boot();
