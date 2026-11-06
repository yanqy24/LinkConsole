import { invoke } from './api.js';

/** 历史命令保留条数：内存与持久化都只留最近 20 条 */
export const HISTORY_MAX = 20;

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  pure: true,
  material: 'auto',     // auto(Mica→亚克力) | acrylic | solid
  fontFamily: "Consolas, 'Cascadia Mono', 'JetBrains Mono', 'Sarasa Mono SC', monospace",
  fontSize: 13,
  bufferLines: 5000,
  prefixMode: 'name',   // name | ip  多控前缀显示
  multiGuard: true,     // 多控拦截不适合广播的命令（全屏/二次交互/输出不稳定）
  showQuickBar: true,   // 底部快捷命令栏
  showHistoryBar: true, // 底部历史命令栏
  autoReconnect: true,  // 断线后自动重连
  restoreCwd: true,     // 重连后恢复原工作目录
  reconnectHint: true,  // 重连后探测 tmux / screen 并给出 attach 提示
  filesWidth: 302,      // 文件面板宽度（可拖拽调节）
  sessionsWidth: 246    // 会话栏宽度（可拖拽调节，180–560）
};

export const state = {
  mode: 'workbench',
  servers: [],
  groups: [],
  proxies: [],
  quickCommands: [],
  settings: { ...DEFAULT_SETTINGS },
  sessions: [],          // { id, serverId, index, name, ip, user, port, status, cwd, unread, host, splitter }
  activeId: null,
  multiSelected: [],     // serverId[]
  multiFilter: 'all',
  collapsedGroups: new Set(),
  collapsedCols: new Set(),
  history: [],           // 用户输入的命令历史
  files: { open: false, path: '/', entries: [], loading: false, sid: null },
  started: Date.now()
};

/* 旧版本曾内置演示数据；这里对已存在的配置做一次性精确清理，
   只移除确定属于种子的条目，不触碰用户自己创建的主机 / 分组 / 快捷命令。 */
const LEGACY_SEED = {
  serverIds: new Set(['srv-web01', 'srv-web02', 'srv-db01']),
  groupNames: new Set(['Web 服务器', 'DB 服务器', '中间件', '默认分组']),
  quickCmds: new Set([
    'df -h', 'free -m', 'ss -tlnp',
    'ps aux --sort=-%mem | head -20', 'tail -n 100 /var/log/syslog'
  ])
};

function stripLegacySeed({ servers, groups, quickCommands }) {
  let dirty = false;
  const keptServers = servers.filter((s) => {
    if (s && LEGACY_SEED.serverIds.has(s.id)) { dirty = true; return false; }
    return true;
  });
  const usedGroups = new Set(keptServers.map((s) => s.group).filter(Boolean));
  const keptGroups = groups.filter((g) => {
    if (LEGACY_SEED.groupNames.has(g) && !usedGroups.has(g)) { dirty = true; return false; }
    return true;
  });
  const keptQuick = quickCommands.filter((q) => {
    if (q && LEGACY_SEED.quickCmds.has(q.cmd)) { dirty = true; return false; }
    return true;
  });
  return { servers: keptServers, groups: keptGroups, quickCommands: keptQuick, dirty };
}

/**
 * 设置项类型兜底。
 * 配置文件可能被手工编辑 / 来自旧版本，fontSize 一旦是字符串，xterm 的
 * new Terminal() 会直接抛异常（表现为会话卡片永久停在「连接中…」）。
 */
function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  s.fontSize = Math.round(num(s.fontSize, DEFAULT_SETTINGS.fontSize, 8, 40));
  s.bufferLines = Math.round(num(s.bufferLines, DEFAULT_SETTINGS.bufferLines, 500, 200000));
  s.filesWidth = Math.round(num(s.filesWidth, DEFAULT_SETTINGS.filesWidth, 220, 680));
  s.sessionsWidth = Math.round(num(s.sessionsWidth, DEFAULT_SETTINGS.sessionsWidth, 180, 560));
  s.fontFamily =
    typeof s.fontFamily === 'string' && s.fontFamily.trim()
      ? s.fontFamily
      : DEFAULT_SETTINGS.fontFamily;
  s.theme = s.theme === 'light' ? 'light' : 'dark';
  s.prefixMode = s.prefixMode === 'ip' ? 'ip' : 'name';
  s.material = ['auto', 'acrylic', 'solid'].includes(s.material) ? s.material : 'auto';
  for (const k of ['pure', 'multiGuard', 'showQuickBar', 'showHistoryBar',
    'autoReconnect', 'restoreCwd', 'reconnectHint']) {
    s[k] = typeof s[k] === 'boolean' ? s[k] : DEFAULT_SETTINGS[k];
  }
  return s;
}

export function loadConfig(cfg) {
  if (!cfg) return;
  let servers = Array.isArray(cfg.servers) ? cfg.servers : [];
  let groups = Array.isArray(cfg.groups) ? cfg.groups : [];
  let quickCommands = Array.isArray(cfg.quickCommands) ? cfg.quickCommands : [];
  const settings = sanitizeSettings(cfg.settings);

  // 旧种子清理只执行一次。
  // 早期实现每次启动都跑，于是用户自己添加的快捷命令只要命令文本撞上种子
  // （df -h / free -m / ss -tlnp 这类最常见），下次启动就会被静默删掉，
  // 表现成「快捷命令没有持久化」。用 settings 里的标记把它变成一次性迁移。
  let dirty = false;
  if (!settings.legacySeedCleared) {
    const r = stripLegacySeed({ servers, groups, quickCommands });
    servers = r.servers;
    groups = r.groups;
    quickCommands = r.quickCommands;
    settings.legacySeedCleared = true;
    dirty = true;
  }

  state.servers = servers;
  state.groups = groups;
  state.proxies = Array.isArray(cfg.proxies) ? cfg.proxies : [];
  state.quickCommands = quickCommands;
  state.settings = settings;

  // 历史命令持久化：只保留最近 HISTORY_MAX 条
  const hist = Array.isArray(cfg.history) ? cfg.history : [];
  state.history = hist.filter((x) => typeof x === 'string' && x.trim()).slice(-HISTORY_MAX);
  if (state.history.length !== hist.length) dirty = true;

  if (dirty) persistSoon();
}

export function snapshotConfig() {
  const demoGroups = new Set(state.servers.filter((s) => s.__demo).map((s) => s.group));
  return {
    servers: state.servers.filter((s) => !s.__demo),
    groups: state.groups.filter((g) => !demoGroups.has(g) && !g.startsWith('__demo__')),
    proxies: state.proxies,
    quickCommands: state.quickCommands,
    history: state.history.slice(-HISTORY_MAX),
    settings: state.settings
  };
}

/** 记录一条历史命令：去重、置顶，只保留最近 HISTORY_MAX 条，并异步落盘 */
export function addHistory(line) {
  const c = String(line || '').replace(/[\r\n]+$/, '');
  if (!c.trim()) return;
  state.history = state.history.filter((x) => x !== c);
  state.history.push(c);
  if (state.history.length > HISTORY_MAX) state.history = state.history.slice(-HISTORY_MAX);
  persistSoon();
}

let saveTimer = null;
export function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist(), 400);
}

export async function persist() {
  try { await invoke('store_save', { config: snapshotConfig() }); }
  catch (e) { console.warn('保存配置失败', e); }
}

/* ---------- 会话辅助 ---------- */
export const sessions = () => state.sessions;
export const byId = (id) => state.sessions.find((s) => s.id === id) || null;
export const byServer = (serverId) => state.sessions.filter((s) => s.serverId === serverId);
export const active = () => byId(state.activeId);
export const getServer = (id) => state.servers.find((s) => s.id === id) || null;
export const getProxy = (id) => state.proxies.find((p) => p.id === id) || null;

export function nextIndex(serverId) {
  const used = new Set(byServer(serverId).map((s) => s.index));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

export function sessionLabel(s) {
  return state.settings.prefixMode === 'ip' ? `${s.ip}[${s.index}]` : `${s.name}[${s.index}]`;
}
