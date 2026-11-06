/**
 * 后端桥接层：
 *  - Tauri 环境：走 invoke / event
 *  - 纯浏览器（npm run dev 调试）：自动降级为内置模拟器，UI 完整可玩
 */
export const IN_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let coreMod = null;
async function core() {
  if (!coreMod) coreMod = await import('@tauri-apps/api/core');
  return coreMod;
}

export async function invoke(cmd, args = {}) {
  if (!IN_TAURI) return mockInvoke(cmd, args);
  const c = await core();
  return c.invoke(cmd, args);
}

const subs = new Map();
export async function listen(event, fn) {
  if (!IN_TAURI) {
    if (!subs.has(event)) subs.set(event, new Set());
    subs.get(event).add(fn);
    return () => subs.get(event)?.delete(fn);
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen(event, (e) => fn(e.payload));
}

function emitMock(event, payload) {
  subs.get(event)?.forEach((fn) => {
    try { fn(payload); } catch (e) { console.error(e); }
  });
}

/* ============================================================
 * 浏览器模拟后端（仅用于 UI 调试，不连接真实主机）
 * ============================================================ */
const mock = {
  seq: 1,
  sessions: new Map(),
  cwd: new Map(),
  inputs: new Map(),   // sessionId -> 当前未回车的输入行（模拟 readline 行缓冲）
  transfers: new Map(),// transferId -> 模拟传输状态（暂停 / 取消）
  config: null,        // store_load / store_save 的内存副本（预览模式下模拟持久化）
};

/* 模拟目录树：与 sftp_list 保持一致，供 Tab 补全使用 */
function mockList(path) {
  const p = ('/' + String(path || '/').split('/').filter(Boolean).join('/')).replace(/\/+$/, '') || '/';
  if (p === '/') return [{ name: 'app', dir: true }, { name: 'logs', dir: true }, { name: 'root', dir: true }];
  if (p === '/app') return [{ name: 'api', dir: true }, { name: 'web', dir: true }];
  if (p === '/app/api') return [{ name: 'logs', dir: true }];
  if (p === '/var/log') return [
    { name: 'nginx', dir: true },
    { name: 'mysql', dir: true },
    { name: 'demo-service.log', dir: false, size: 1284503296 },
    { name: 'syslog', dir: false, size: 18432512 },
    { name: 'secure', dir: false, size: 2385920 },
    { name: 'wtmp', dir: false, size: 115200 },
  ];
  if (p === '/var/log/nginx') return [
    { name: 'access.log', dir: false, size: 1284503296 },
    { name: 'error.log', dir: false, size: 89128960 },
    { name: 'access.log.1.gz', dir: false, size: 94371840 },
    { name: 'error.log.1.gz', dir: false, size: 6291456 },
  ];
  return [{ name: 'logs', dir: true }];
}

/** bash 式 Tab 补全：返回应回显的后缀（含目录尾斜杠），无匹配返回空串 */
function mockComplete(line, cwd) {
  const word = /(\S*)$/.exec(line)[1];
  let dirPart = cwd, frag = word;
  if (word.includes('/')) {
    const i = word.lastIndexOf('/');
    frag = word.slice(i + 1);
    dirPart = word.slice(0, i + 1);
  } else if (word.startsWith('~')) {
    dirPart = '/root'; frag = word.slice(1).replace(/^\//, '');
  }
  const base = dirPart.startsWith('/') ? dirPart : cwd.replace(/\/+$/, '') + '/' + dirPart;
  const dir = ('/' + base.split('/').filter(Boolean).join('/')).replace(/\/+$/, '') || '/';
  const hits = mockList(dir).filter((e) => frag === '' || e.name.startsWith(frag));
  if (!hits.length) return '';
  let common = hits[0].name;
  for (const h2 of hits) { let i = 0; while (i < common.length && common[i] === h2.name[i]) i++; common = common.slice(0, i); }
  if (!common) return '';
  const isDir = common === hits[0].name && hits[0].dir;
  return common.slice(frag.length) + (hits.length === 1 && isDir ? '/' : '');
}

const BANNER = (s) =>
  `Last login: ${new Date().toUTCString()} from 192.0.2.2\r\n` +
  `Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-112-generic x86_64)\r\n\r\n`;

/** bash 风格彩色提示符（PS1） */
function promptOf(s, cwd) {
  return `\x1b[01;32m${s.user}@${s.name}\x1b[0m:\x1b[01;34m${cwd}\x1b[0m# `;
}

function fakeOutput(cmd, cwd, user, host) {
  const c = cmd.trim();
  if (c === 'pwd') return cwd;
  /* —— README 截图场景：按主机区分数值，展示多控聚合与单会话内容 —— */
  if (c === 'wc -l /var/log/nginx/access.log') {
    const n = { Web01: 1284503, Web02: 1197882, DB01: 96338 }[host] || 1024768;
    return `${n} /var/log/nginx/access.log`;
  }
  if (c === "grep -c ' 500 ' /var/log/nginx/access.log") {
    const n = { Web01: 2314, Web02: 2089, DB01: 178 }[host] || 1024;
    return `${n} /var/log/nginx/access.log`;
  }
  if (c === 'docker ps') {
    const rows = [
      ['f3a9c21e7b04', 'demo-api:1.0.0', 'Up 12 days', '0.0.0.0:8080->8080/tcp, :::8080->8080/tcp', 'demo-api'],
      ['9d47be0a5c11', 'redis:7-alpine', 'Up 12 days', '6379/tcp', 'redis'],
      ['44e1f2c0b8d3', 'nginx:1.25-alpine', 'Up 12 days', '0.0.0.0:443->443/tcp, :::443->443/tcp', 'gateway'],
    ];
    return [
      ['CONTAINER ID', 'IMAGE', 'STATUS', 'PORTS', 'NAMES'].reduce((s, w, i) => s + w.padEnd([15, 22, 16, 44][i] ?? w.length), ''),
      ...rows.map(([id, img, st, ports, name]) =>
        `${id.padEnd(15)}${img.padEnd(22)}${st.padEnd(16)}${ports.padEnd(44)}${name}`), '',
    ];
  }
  if (c === 'ls -lh' && cwd === '/var/log/nginx') return [
    'total 1.4G',
    '-rw-r----- 1 www-data adm 1.2G Nov  6 14:58 access.log',
    '-rw-r----- 1 www-data adm   85M Nov  6 14:58 error.log',
    '-rw-r----- 1 www-data adm   90M Nov  6 03:28 access.log.1.gz',
    '-rw-r----- 1 www-data adm  6.0M Nov  6 03:28 error.log.1.gz', ''];
  if (c.startsWith('tail -n 5 /var/log/nginx/error.log')) {
    const day = host === 'Web01' ? '04' : '05';
    const tail = [
      `2026/11/${day} 23:41:02 [error] 1831#1831: *92477 connect() failed (111: Connection refused) while connecting to upstream, client: 192.0.2.77, server: api.example.com, request: "GET /api/orders HTTP/2.0", upstream: "192.0.2.12:8081", host: "api.example.com"`,
      `2026/11/${day} 23:52:37 [error] 1831#1831: *92501 upstream timed out (110: Connection timed out) while reading response header from upstream, client: 203.0.113.42, server: api.example.com, request: "POST /api/callback HTTP/2.0", upstream: "192.0.2.12:8081", host: "api.example.com"`,
      `2026/11/05 23:58:11 [warn] 1831#1831: *92544 upstream server temporarily disabled, client: 203.0.113.88, server: api.example.com, upstream: "192.0.2.12:8081"`,
      `2026/11/06 00:03:44 [error] 1831#1831: *92607 no live upstreams while connecting to upstream, client: 203.0.113.19, server: api.example.com, request: "GET /health HTTP/2.0", upstream: "http://demo-backend:8080/health", host: "api.example.com"`, ''];
    return day === '04' ? tail : tail.slice(1);
  }
  if (c === 'ls' || c.startsWith('ls ')) return ['app  backup  conf  logs  nginx  ssl', ''];
  if (c.startsWith('cd')) return '';
  if (c.startsWith('df -h')) {
    const base = [
      'Filesystem      Size  Used Avail Use% Mounted on',
      '/dev/vda1        40G   18G   22G  45% /',
      'tmpfs           3.2G     0  3.2G   0% /dev/shm'];
    return c.includes('/data')
      ? [...base, 'overlay         200G  142G   58G  71% /data', '']
      : [...base, ''];
  }
  if (c === 'free -m') return [
    '               total        used        free      shared',
    'Mem:            6421        3180        1421         128',
    'Swap:           2047           0        2047', ''];
  if (c === 'uptime') return ' 17:32:01 up 24 days,  4:12,  2 users,  load average: 0.18, 0.22, 0.19';
  if (c.startsWith('echo')) return c.slice(4).trim().replace(/^"|"$/g, '');
  if (c === 'vim' || c.startsWith('vim ') || c.startsWith('top') || c.startsWith('htop')) return '';
  return `${c}: command output (browser demo)\r\n`;
}

async function mockInvoke(cmd, args) {
  switch (cmd) {
    case 'store_load': return mock.config || {};
    case 'store_save': mock.config = args.config; return true;
    case 'app_info': return { name: 'LinkConsole', version: '1.0.0 (browser demo)', platform: 'web', arch: '-', ssh: 'mock' };
    case 'default_download_dir': return 'C:\\Users\\demo\\Downloads';
    case 'ssh_connect': {
      const id = 'mock-' + mock.seq++;
      mock.sessions.set(id, { ...args.server });
      mock.cwd.set(id, '/root');
      mock.inputs.set(id, '');
      setTimeout(() => emitMock('ssh-data', { id, data: BANNER() }), 120);
      setTimeout(() => emitMock('ssh-data', { id, data: promptOf(mock.sessions.get(id), '/root') }), 200);
      setTimeout(() => emitMock('ssh-cwd', { id, data: '/root' }), 220);
      return { id, serverId: args.server.id, name: args.server.name, ip: args.server.ip, user: args.server.user, port: args.server.port, cols: args.cols, rows: args.rows };
    }
    case 'ssh_write': {
      const s = mock.sessions.get(args.sessionId);
      if (!s) return;
      let cwd = mock.cwd.get(args.sessionId) || '/root';
      const data = String(args.data ?? '');
      if (data.includes('\x1b')) return;   // 方向键 / 历史等按键序列：模拟器不处理
      const prompt = () => promptOf(s, cwd);
      const echo = (t) => { if (t) emitMock('ssh-data', { id: args.sessionId, data: t }); };
      let line = mock.inputs.get(args.sessionId) || '';
      // 逐字符处理并即时回显，与真实 PTY 一致：可打印字符原样回显、
      // Tab 补全回显后缀、回车结束本行并执行（保证回显行 = prompt + 完整命令）
      for (const ch of data) {
        if (ch === '\t') {
          const suffix = mockComplete(line, cwd);
          if (suffix) { line += suffix; echo(suffix); }
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          const cmd = line;
          line = '';
          mock.inputs.set(args.sessionId, line);
          echo('\r\n');
          if (/^cd(\s|$)/.test(cmd)) {
            // 去引号：LinkConsole 重连恢复目录时会发 cd '/path'
            const t = cmd.slice(2).trim().replace(/\/+$/, '').replace(/^(['"])(.*)\1$/, '$2');
            const nc = !t || t === '~' ? '/root'
              : t === '..' ? (cwd.replace(/\/[^/]+$/, '') || '/')
              : t.startsWith('/') ? t
              : `${cwd}/${t}`.replace(/\/+/g, '/');
            cwd = nc || '/';
            mock.cwd.set(args.sessionId, cwd);
            setTimeout(() => emitMock('ssh-cwd', { id: args.sessionId, data: cwd }), 80);
          }
          const out = fakeOutput(cmd, cwd, s.user, s.name);
          const outText = Array.isArray(out) ? out.join('\r\n') : out;
          setTimeout(() => {
            echo(outText ? outText + '\r\n' : '');
            echo(prompt());
          }, 60);
          continue;
        }
        if (ch === '\x7f') { line = line.slice(0, -1); echo('\b \b'); continue; }
        if (ch.charCodeAt(0) < 32) continue;
        line += ch;
        echo(ch);
      }
      mock.inputs.set(args.sessionId, line);
      return;
    }
    case 'ssh_resize': return;
    case 'ssh_close': { mock.sessions.delete(args.sessionId); return; }
    case 'session_cwd': return mock.cwd.get(args.sessionId) || '/';
    case 'probe_cwd': return mock.cwd.get(args.sessionId) || '/';
    case 'net_probe': return '直连（浏览器模拟）';
    case 'net_probe_proxy': return { level: 'ok', message: '代理可达（浏览器模拟）' };
    case 'sftp_list':
      return mockList(args.path).map((e, i) => ({
        name: e.name,
        path: (args.path === '/' ? '' : args.path.replace(/\/+$/, '')) + '/' + e.name,
        is_dir: e.dir,
        size: e.dir ? 0 : (e.size ?? 2431),
        mtime: Date.now() / 1000 - 600 - i * 3600,
        mode: e.dir ? 'drwxr-xr-x' : '-rw-r-----',
      }));
    case 'sftp_start_upload':
    case 'sftp_start_download': {
      // 模拟一次真实速率的传输：可暂停 / 继续 / 取消，进度事件与后端同构
      const tid = args.transferId;
      const isUp = cmd === 'sftp_start_upload';
      const total = isUp ? 8 * 1024 * 1024 : 96 * 1024 * 1024;
      const name = isUp
        ? String(args.localPath || '').split(/[\\/]/).pop() || 'demo.bin'
        : String(args.remotePath || '').split('/').pop() || 'demo.bin';
      const st = { paused: false, cancelled: false, done: 0, timer: null };
      mock.transfers.set(tid, st);
      st.timer = setInterval(() => {
        if (st.cancelled) {
          clearInterval(st.timer);
          mock.transfers.delete(tid);
          emitMock('sftp-progress', { transferId: tid, name, transferred: st.done, total, done: false, state: 'cancelled', resumedFrom: 0, error: '' });
          return;
        }
        if (st.paused) return;
        st.done = Math.min(total, st.done + 0.3 * 1024 * 1024);
        const finished = st.done >= total;
        emitMock('sftp-progress', {
          transferId: tid, name, transferred: st.done, total, done: finished,
          state: finished ? 'done' : 'running', resumedFrom: 0, error: ''
        });
        if (finished) { clearInterval(st.timer); mock.transfers.delete(tid); }
      }, 120);
      return;
    }
    case 'sftp_pause_transfer': {
      const t = mock.transfers.get(args.transferId);
      if (t) t.paused = true;
      return !!t;
    }
    case 'sftp_resume_transfer': {
      const t = mock.transfers.get(args.transferId);
      if (t) t.paused = false;
      return !!t;
    }
    case 'sftp_cancel_transfer': {
      const t = mock.transfers.get(args.transferId);
      if (t) t.cancelled = true;
      return !!t;
    }
    case 'ssh_exec_quiet':
      // 模拟远端存在一个 tmux 会话，便于在浏览器预览里看到重连后的恢复提示
      return /tmux/.test(String(args.cmd || '')) ? 'work: 2 windows (created Wed Nov 5 09:12:03 2026)\n' : '';
    case 'sftp_mkdir': case 'sftp_remove': case 'sftp_rename': case 'reveal_local': return;
    default:
      console.warn('[mock] unknown command', cmd, args);
      return null;
  }
}
