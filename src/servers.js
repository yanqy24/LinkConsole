/**
 * 服务器管理栏：分组树、主机 CRUD、代理服务器管理、右键菜单
 */
import { state, getServer, getProxy, byServer, persistSoon, persist } from './state.js';
import { invoke, IN_TAURI } from './api.js';
import { $, h, esc, toast, openCtx, openModal, menuIcon } from './ui.js';
import { renderSessionList, createSession } from './sessions.js';
import { renderStatus, refreshServerFoot, toggleCol } from './workspace.js';

const hue = (seed) => {
  let x = 0;
  for (const c of String(seed)) x = (x * 31 + c.charCodeAt(0)) % 360;
  return x;
};

export function renderServerTree() {
  const tree = $('#serverTree');
  tree.innerHTML = '';
  const groups = [...new Set([...state.groups, ...state.servers.map((s) => s.group)])].filter(Boolean);
  state.groups = groups;

  if (!state.servers.length) {
    const es = h('div', 'empty-state');
    es.innerHTML =
      '<div class="es-ico">' + menuIcon('host') + '</div>' +
      '<div class="es-t">还没有主机</div>' +
      '<div class="es-s">新建一台主机，开始你的第一个 SSH 会话</div>' +
      '<button class="es-btn" id="esNewHost">' + menuIcon('plus') + '<span>新建主机</span></button>' +
      '<div class="es-tip">此处右键可管理分组与代理</div>';
    es.querySelector('#esNewHost').addEventListener('click', () => hostModal());
    tree.appendChild(es);
  }

  groups.forEach((g) => {
    const servers = state.servers.filter((s) => s.group === g);
    const group = h('div', `tree-group${state.collapsedGroups.has(g) ? ' collapsed' : ''}`);
    const head = h('div', 'tree-group-head');
    head.innerHTML =
      '<svg class="caret" viewBox="0 0 24 24" fill="none"><path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      `<span class="g-name">${esc(g)}</span>` +
      `<span class="g-count">${servers.length}</span>` +
      '<button class="mini-btn g-add" data-tip="在此分组新建主机"><svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg></button>';
    head.addEventListener('click', (e) => {
      if (e.target.closest('.g-add')) { hostModal({ group: g }); return; }
      state.collapsedGroups.has(g) ? state.collapsedGroups.delete(g) : state.collapsedGroups.add(g);
      renderServerTree();
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, [
        { title: g, sub: `${servers.length} 台主机`, icon: 'folder' },
        { label: '多控本组服务器', icon: 'layers', kbd: 'Ctrl M', act: () => multiControlGroup(g) },
        { label: '在此分组新建主机', icon: 'plus', kbd: 'Ctrl N', act: () => hostModal({ group: g }) },
        { sep: true },
        { label: '重命名分组', icon: 'pencil', act: () => renameGroupModal(g) },
        { sep: true },
        { label: '删除分组', icon: 'trash', danger: true, act: () => deleteGroup(g) }
      ]);
    });
    const body = h('div', 'tree-group-body');
    servers.forEach((srv) => body.appendChild(serverRow(srv)));
    group.appendChild(head);
    group.appendChild(body);
    tree.appendChild(group);
  });

  refreshServerFoot();
}

function serverRow(srv) {
  const el = h('div', 'tree-server');
  const ss = byServer(srv.id);
  const live = ss.filter((s) => s.status === 'open').length;
  const proxy = srv.proxy_id ? getProxy(srv.proxy_id) : null;
  el.innerHTML =
    `<span class="srv-avatar" style="background:linear-gradient(145deg,hsl(${hue(srv.id)} 62% 52%),hsl(${(hue(srv.id) + 26) % 360} 62% 42%))">${esc(srv.name.slice(0, 2).toUpperCase())}</span>` +
    `<span class="srv-info"><span class="srv-name">${esc(srv.name)}</span><span class="srv-ip">${esc(srv.ip)}${srv.port && srv.port !== 22 ? ':' + srv.port : ''}</span></span>` +
    `<span class="srv-badges">` +
    (ss.length ? `<span class="sess-tag">${ss.length}</span>` : '') +
    (proxy ? `<span class="srv-proxy" data-tip="代理 · ${esc(proxy.name)} (${esc(proxy.host)}:${proxy.port})"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3v6m0 0a3 3 0 103 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5 21h14M7 21l1.6-6h6.8L17 21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : '') +
    (live ? '<span class="srv-live"></span>' : '') +
    '</span>';

  el.addEventListener('click', () => {
    const open = byServer(srv.id).find((s) => s.status === 'open');
    if (open && state.mode === 'workbench') import('./sessions.js').then((m) => m.activate(open.id));
    else if (state.mode === 'multi') toggleInMulti(srv.id);
  });
  el.addEventListener('dblclick', () => createSession(srv));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCtx(e.clientX, e.clientY, [
      { title: srv.name, sub: `${srv.ip}:${srv.port || 22} · ${srv.os || 'Linux'}`, icon: 'host' },
      { label: '新建会话', icon: 'terminal', kbd: '双击', act: () => createSession(srv) },
      { label: '多控本组服务器', icon: 'layers', act: () => multiControlGroup(srv.group) },
      { sep: true },
      { label: '编辑主机', icon: 'pencil', act: () => hostModal(srv) },
      { label: '复制主机', icon: 'copy', act: () => { const c = { ...srv, id: '', name: srv.name + '-copy' }; delete c.id; hostModal(c); } },
      { label: '测试连接', icon: 'pulse', act: () => testConnection(srv) },
      { label: '重置主机密钥', icon: 'shield', act: () => resetHostKey(srv) },
      { sep: true },
      { label: '删除主机', icon: 'trash', danger: true, act: () => deleteServer(srv) }
    ]);
  });
  return el;
}

async function toggleInMulti(serverId) {
  const i = state.multiSelected.indexOf(serverId);
  if (i >= 0) state.multiSelected.splice(i, 1);
  else state.multiSelected.push(serverId);
  const m = await import('./multi.js');
  m.onMultiSelectionChanged();
  renderSessionList();
}

export function multiControlGroup(group) {
  const ids = state.servers.filter((s) => s.group === group).map((s) => s.id);
  if (!ids.length) { toast('该分组暂无主机', 'warn'); return; }
  state.multiSelected = ids.slice();
  import('./workspace.js').then((w) => w.switchMode('multi'));
}

export function blankCtx(e) {
  const collapsed = state.collapsedGroups.size > 0;
  openCtx(e.clientX, e.clientY, [
    { title: '服务器管理', sub: `${state.servers.length} 台主机 · ${state.groups.length} 个分组`, icon: 'host' },
    { label: '新建主机', icon: 'plus', kbd: 'Ctrl N', act: () => hostModal() },
    { label: '新建分组', icon: 'folderPlus', act: () => renameGroupModal(null) },
    { label: '代理服务器管理', icon: 'proxy', act: () => proxyModal() },
    { sep: true },
    {
      label: collapsed ? '展开全部分组' : '收起全部分组',
      icon: collapsed ? 'expand' : 'collapse',
      act: () => {
        if (collapsed) state.collapsedGroups.clear();
        else state.groups.forEach((g) => state.collapsedGroups.add(g));
        renderServerTree();
      }
    },
    { label: '收起服务器栏', icon: 'panelLeft', act: () => toggleCol('servers', true) }
  ]);
}

/* ---------------- 主机表单 ---------------- */
export function hostModal(srv) {
  const edit = !!(srv && srv.id);
  const v = srv || { name: '', ip: '', port: 22, user: 'root', group: state.groups[0] || '默认分组', auth: 'password', password: '', key_path: '', proxy_id: '', os: 'Linux' };
  const groupOpts = [...new Set([...state.groups, v.group].filter(Boolean))]
    .map((g) => `<option value="${esc(g)}"${g === v.group ? ' selected' : ''}>${esc(g)}</option>`).join('');
  const proxyOpts = ['<option value="">不使用代理（直连）</option>']
    .concat(state.proxies.map((p) => `<option value="${esc(p.id)}"${p.id === v.proxy_id ? ' selected' : ''}>${esc(p.kind.toUpperCase())} · ${esc(p.name)} (${esc(p.host)}:${p.port})</option>`))
    .join('');

  const mask = openModal(
    '<div class="fgrid-3">' +
    '<div class="field"><label>主机名称</label><input id="hName" placeholder="Web01" value="' + esc(v.name) + '"/></div>' +
    '<div class="field"><label>分组</label><select id="hGroup">' + groupOpts + '</select></div>' +
    '</div>' +
    '<div class="fgrid-3">' +
    '<div class="field"><label>IP / 域名</label><input id="hIp" placeholder="192.0.2.10" value="' + esc(v.ip) + '"/></div>' +
    '<div class="field"><label>端口</label><input id="hPort" type="number" value="' + (v.port || 22) + '"/></div>' +
    '</div>' +
    '<div class="fgrid-3">' +
    '<div class="field"><label>用户名</label><input id="hUser" value="' + esc(v.user) + '"/></div>' +
    '<div class="field"><label>认证方式</label><select id="hAuth">' +
    '<option value="password"' + (v.auth !== 'key' ? ' selected' : '') + '>密码</option>' +
    '<option value="key"' + (v.auth === 'key' ? ' selected' : '') + '>私钥文件</option></select></div>' +
    '</div>' +
    '<div class="field" id="rowPass"><label>密码</label><input id="hPass" type="password" placeholder="••••••••" value="' + esc(v.password) + '"/></div>' +
    '<div class="field" id="rowKey" style="display:none"><label>私钥文件路径</label>' +
    '<div style="display:flex;gap:6px"><input id="hKey" placeholder="C:\\Users\\you\\.ssh\\id_ed25519" value="' + esc(v.key_path) + '"/>' +
    '<button class="btn" id="hKeyPick" type="button">浏览…</button></div></div>' +
    '<div class="field"><label>代理服务器</label><select id="hProxy">' + proxyOpts + '</select>' +
    '<div class="hint">没有需要的代理？<a href="#" id="hProxyMgr" style="color:var(--accent-2)">管理代理服务器…</a></div></div>' +
    '<div class="m-foot"><button class="btn" id="hTest" type="button">测试连接</button><span class="spacer"></span>' +
    '<button class="btn" data-close>取消</button><button class="btn primary" id="hSave">' + (edit ? '保存' : '创建并连接') + '</button></div>',
    { title: edit ? `编辑主机 · ${v.name}` : '新建主机', sub: '支持密码 / 私钥 / 经代理跳板连接', onClose: () => {} }
  );

  const q = (s) => mask.querySelector(s);
  const authSel = q('#hAuth');
  const syncAuth = () => {
    q('#rowPass').style.display = authSel.value === 'key' ? 'none' : '';
    q('#rowKey').style.display = authSel.value === 'key' ? '' : 'none';
  };
  authSel.addEventListener('change', syncAuth);
  syncAuth();

  q('#hKeyPick').addEventListener('click', async () => {
    if (!IN_TAURI) { toast('浏览器演示模式不支持文件选择', 'warn'); return; }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const file = await open({ multiple: false, title: '选择私钥文件' });
      if (file) q('#hKey').value = file;
    } catch (e) { toast('打开文件选择器失败', 'warn'); }
  });

  q('#hProxyMgr').addEventListener('click', (e) => {
    e.preventDefault();
    const keep = readForm();
    const pm = proxyModal(() => {
      hostModal({ ...keep, id: keep.id || (edit ? v.id : '') });
    });
    mask.close();
    return pm;
  });

  q('#hTest').addEventListener('click', async () => {
    const f = readForm();
    q('#hTest').textContent = '测试中…';
    try {
      const via = await invoke('net_probe', { target: `${f.ip}:${f.port}`, proxyId: f.proxy_id || '' });
      toast(`TCP 可达（${via}）`, 'ok');
    } catch (e) {
      toast(typeof e === 'string' ? e : e?.message || '连接失败', 'warn', 4200);
    }
    q('#hTest').textContent = '测试连接';
  });

  q('#hSave').addEventListener('click', async () => {
    const f = readForm();
    if (!f.name || !f.ip) { toast('请填写名称与 IP', 'warn'); return; }
    if (edit) {
      Object.assign(v, f);
    } else {
      f.id = 'srv-' + Date.now().toString(36);
      state.servers.push(f);
    }
    if (!state.groups.includes(f.group)) state.groups.push(f.group);
    await persist();
    renderServerTree();
    mask.close();
    toast(edit ? `已保存 ${f.name}` : `已添加 ${f.name}`, 'ok');
    if (!edit && f.auth) createSession(f);
  });
  mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
  setTimeout(() => q('#hName').focus(), 50);

  function readForm() {
    return {
      id: v.id || '',
      name: q('#hName').value.trim(),
      group: q('#hGroup').value || '默认分组',
      ip: q('#hIp').value.trim(),
      port: +q('#hPort').value || 22,
      user: q('#hUser').value.trim() || 'root',
      auth: q('#hAuth').value,
      password: q('#hPass').value,
      key_path: q('#hKey').value.trim(),
      proxy_id: q('#hProxy').value || '',
      os: v.os || 'Linux'
    };
  }
}

async function testConnection(srv) {
  toast(`正在测试 ${srv.name} …`);
  try {
    const via = await invoke('net_probe', { target: `${srv.ip}:${srv.port}`, proxyId: srv.proxy_id || '' });
    toast(`${srv.name} TCP 可达（${via}）`, 'ok');
  } catch (e) {
    toast(typeof e === 'string' ? e : e?.message || '连接失败', 'warn', 4200);
  }
}

/**
 * 重置主机密钥：清掉本机 known_hosts 里该主机的记录。
 * 只在服务器重装 / 确认密钥更换后使用——否则等于主动放弃中间人防护。
 */
function resetHostKey(srv) {
  const mask = openModal(
    `<div class="hint" style="font-size:12px;line-height:1.8">将删除 <b>${esc(srv.name)}</b>（${esc(srv.ip)}:${srv.port || 22}）在本机记录的服务器密钥。<br/>下次连接会按「首次连接」重新记录新密钥。<br/><b>仅在确认服务器重装过或密钥确实更换时使用</b>，否则可能放过中间人。</div>` +
      '<div class="m-foot"><span class="spacer"></span><button class="btn" data-close>取消</button>' +
      '<button class="btn primary" id="hkOk" style="background:var(--term-red);border-color:var(--term-red)">清除记录</button></div>',
    { title: '重置主机密钥' }
  );
  mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
  mask.querySelector('#hkOk').addEventListener('click', async () => {
    try {
      const n = await invoke('host_key_forget', { host: srv.ip, port: srv.port || 22 });
      mask.close();
      if (n > 0) toast(`已清除 ${n} 条主机密钥记录`, 'ok');
      else toast('本机没有该主机的密钥记录', 'warn');
    } catch (e) {
      toast(typeof e === 'string' ? e : e?.message || '清除失败', 'warn', 4200);
    }
  });
}

function deleteServer(srv) {
  const mask = openModal(
    `<div class="hint" style="font-size:12px;line-height:1.8">将删除主机 <b>${esc(srv.name)} (${esc(srv.ip)})</b> 及其配置，已建立的会话会一并断开。<br/>该操作不可撤销。</div>` +
    '<div class="m-foot"><span class="spacer"></span><button class="btn" data-close>取消</button><button class="btn primary" id="delOk" style="background:var(--term-red);border-color:var(--term-red)">删除</button></div>',
    { title: '删除主机' }
  );
  mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
  mask.querySelector('#delOk').addEventListener('click', async () => {
    import('./sessions.js').then(async (m) => {
      for (const s of byServer(srv.id).slice()) await m.closeSession(s, { quiet: true });
    });
    state.servers = state.servers.filter((s) => s.id !== srv.id);
    state.multiSelected = state.multiSelected.filter((id) => id !== srv.id);
    await persist();
    renderServerTree();
    renderSessionList();
    mask.close();
    toast(`已删除 ${srv.name}`, 'ok');
  });
}

/* ---------------- 分组 ---------------- */
function renameGroupModal(g) {
  const isNew = !g;
  const mask = openModal(
    '<div class="field"><label>分组名称</label><input id="gName" value="' + esc(g || '') + '" placeholder="如：Web 服务器"/></div>' +
    '<div class="m-foot"><span class="spacer"></span><button class="btn" data-close>取消</button><button class="btn primary" id="gSave">' + (isNew ? '创建' : '保存') + '</button></div>',
    { title: isNew ? '新建分组' : '重命名分组' }
  );
  mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
  mask.querySelector('#gSave').addEventListener('click', async () => {
    const name = mask.querySelector('#gName').value.trim();
    if (!name) { toast('名称不能为空', 'warn'); return; }
    if (isNew) {
      if (!state.groups.includes(name)) state.groups.push(name);
    } else if (name !== g) {
      state.servers.forEach((s) => { if (s.group === g) s.group = name; });
      state.groups = state.groups.map((x) => (x === g ? name : x));
    }
    await persist();
    renderServerTree();
    mask.close();
  });
  setTimeout(() => mask.querySelector('#gName').focus(), 50);
}

async function deleteGroup(g) {
  const n = state.servers.filter((s) => s.group === g).length;
  if (n) { toast(`分组内还有 ${n} 台主机，请先移出`, 'warn'); return; }
  state.groups = state.groups.filter((x) => x !== g);
  await persist();
  renderServerTree();
}

/* ---------------- 代理服务器管理 ---------------- */
export function proxyModal(onDone) {
  const listHTML = () => state.proxies.length
    ? state.proxies.map((p) =>
      `<div class="pitem"><span class="pi-ico"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3v6m0 0a3 3 0 103 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5 21h14M7 21l1.6-6h6.8L17 21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` +
      `<span style="flex:1;min-width:0"><div style="font-size:12.5px">${esc(p.name)} <span class="sess-tag">${esc(p.kind.toUpperCase())}</span></div>` +
      `<div style="font-size:10.5px;color:var(--text-faint);font-family:var(--mono)">${esc(p.host)}:${p.port}${p.username ? ' · ' + esc(p.username) : ''}</div></span>` +
      `<button class="btn p-edit" data-id="${esc(p.id)}">编辑</button><button class="btn p-del" data-id="${esc(p.id)}">删除</button></div>`).join('')
    : '<div class="hint">暂无代理服务器，点击右下角新建。</div>';

  const mask = openModal(
    '<div class="plist" id="pList">' + listHTML() + '</div>' +
    '<div class="m-foot"><span class="hint" style="margin-right:auto">支持 SOCKS5 / HTTP CONNECT / JUMPHOST（SSH 跳板机）</span>' +
    '<button class="btn" data-close>关闭</button><button class="btn primary" id="pNew">+ 新建代理</button></div>',
    { title: '代理服务器管理', wide: true }
  );

  const refresh = () => { mask.querySelector('#pList').innerHTML = listHTML(); bind(); };
  const bind = () => {
    mask.querySelectorAll('.p-edit').forEach((b) => b.addEventListener('click', () => proxyForm(state.proxies.find((x) => x.id === b.dataset.id), refresh)));
    mask.querySelectorAll('.p-del').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      state.servers.forEach((s) => { if (s.proxy_id === id) s.proxy_id = ''; });
      state.proxies = state.proxies.filter((x) => x.id !== id);
      await persist();
      renderServerTree();
      refresh();
    }));
  };
  bind();
  mask.querySelector('[data-close]').addEventListener('click', () => { mask.close(); onDone && onDone(); });
  mask.querySelector('#pNew').addEventListener('click', () => proxyForm(null, refresh));
  return mask;
}

function proxyForm(p, onSaved) {
  const v = p || { id: '', name: '', kind: 'socks5', host: '', port: 1080, username: '', password: '', auth: 'password', key_path: '' };
  const formId = v.id || 'px-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const mask = openModal(
    '<div class="fgrid-3">' +
    '<div class="field"><label>名称</label><input id="pfName" value="' + esc(v.name) + '" placeholder="机房跳板机"/></div>' +
    '<div class="field"><label>类型</label><select id="pfKind">' +
      '<option value="socks5"' + (v.kind === 'socks5' ? ' selected' : '') + '>SOCKS5</option>' +
      '<option value="http"' + (v.kind === 'http' ? ' selected' : '') + '>HTTP CONNECT</option>' +
      '<option value="jump"' + (v.kind === 'jump' ? ' selected' : '') + '>JUMPHOST（SSH 跳板机）</option>' +
    '</select></div>' +
    '</div>' +
    '<div class="fgrid-3">' +
    '<div class="field"><label>IP / 域名</label><input id="pfHost" value="' + esc(v.host) + '" placeholder="198.51.100.21"/></div>' +
    '<div class="field"><label>端口</label><input id="pfPort" type="number" value="' + (v.port || 1080) + '"/></div>' +
    '</div>' +
    '<div id="pfCred">' +
    '<div class="fgrid-3">' +
    '<div class="field"><label>用户名</label><input id="pfUser" value="' + esc(v.username) + '"/></div>' +
    '<div class="field"><label>密码</label><input id="pfPass" type="password" value="' + esc(v.password) + '"/></div>' +
    '</div></div>' +
    '<div id="pfJump" hidden>' +
    '<div class="fgrid-3">' +
    '<div class="field"><label>认证方式</label><select id="pfAuth">' +
      '<option value="password"' + (v.auth !== 'key' ? ' selected' : '') + '>密码</option>' +
      '<option value="key"' + (v.auth === 'key' ? ' selected' : '') + '>私钥</option>' +
    '</select></div>' +
    '<div class="field"><label>用户名</label><input id="pfUser2" value="' + esc(v.username) + '" placeholder="root"/></div>' +
    '<div class="field"><label>密码 / 私钥口令</label><input id="pfPass2" type="password" value="' + esc(v.password) + '"/></div>' +
    '</div>' +
    '<div class="field"><label>私钥路径（认证方式 = 私钥 时必填）</label><input id="pfKeyPath" value="' + esc(v.key_path || '') + '" placeholder="C:\\Users\\you\\.ssh\\id_rsa"/></div>' +
    '<div class="hint">JUMPHOST = XShell 跳板机：先 SSH 登录此机器，再经它转发连接目标主机。请确保跳板机允许 TCP 转发（AllowTcpForwarding）。</div>' +
    '</div>' +
    '<div class="m-foot"><button class="btn" id="pfTest" type="button">测试连接</button><span class="spacer"></span>' +
    '<button class="btn" data-close>取消</button><button class="btn primary" id="pfSave">保存</button></div>',
    { title: p ? '编辑代理' : '新建代理' }
  );
  const q = (s) => mask.querySelector(s);

  // 类型切换：JUMPHOST 走 SSH 凭据（用户名/密码/私钥），常规代理走可选的代理认证
  const syncKind = () => {
    const kind = q('#pfKind').value;
    const isJump = kind === 'jump';
    q('#pfJump').hidden = !isJump;
    q('#pfCred').hidden = isJump;
    q('#pfPort').placeholder = isJump ? '22' : '1080';
    if (!q('#pfPort').dataset.dirty) q('#pfPort').value = isJump ? 22 : 1080;
  };
  q('#pfKind').addEventListener('change', syncKind);
  q('#pfPort').addEventListener('input', () => { q('#pfPort').dataset.dirty = '1'; });
  if (v.kind === 'jump') q('#pfPort').dataset.dirty = '1';
  syncKind();

  mask.querySelector('[data-close]').addEventListener('click', () => mask.close());
  q('#pfTest').addEventListener('click', async () => {
    const btn = q('#pfTest');
    if (btn.disabled) return;
    const f = readForm();
    if (!f.host) { toast('请填写代理 IP / 域名', 'warn'); return; }
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      // 直接把表单里的定义交给后端测试：不写入 state、不落库，
      // 未保存的代理也能测（早前先写 state 再按 id 查后端，既测不到又会重复新增）。
      // 后端只验证代理/跳板机自身是否可用（SOCKS5 握手、HTTP 认证、SSH 登录），不需要测试目标。
      const r = await invoke('net_probe_proxy', { proxy: f });
      const msg = typeof r === 'string' ? r : r?.message || '连接成功';
      const warn = r?.level === 'warn';
      toast(msg, warn ? 'warn' : 'ok', warn ? 7000 : 3600);
    } catch (e) {
      toast(typeof e === 'string' ? e : e?.message || '连接失败', 'warn', 5200);
    }
    btn.disabled = false;
    btn.textContent = '测试连接';
  });
  q('#pfSave').addEventListener('click', async () => {
    const f = readForm();
    if (!f.name || !f.host) { toast('请填写名称与 IP', 'warn'); return; }
    if (f.kind === 'jump' && !f.password && !f.username) { toast('请填写跳板机用户名与密码', 'warn'); return; }
    if (p) Object.assign(p, f);
    else state.proxies.push(f);
    await persist();
    renderServerTree();
    mask.close();
    onSaved && onSaved();
    toast('代理已保存', 'ok');
  });
  function readForm() {
    const kind = q('#pfKind').value;
    const isJump = kind === 'jump';
    return {
      id: formId,
      name: q('#pfName').value.trim(),
      kind,
      host: q('#pfHost').value.trim(),
      port: +q('#pfPort').value || (isJump ? 22 : 1080),
      username: (isJump ? q('#pfUser2').value : q('#pfUser').value).trim(),
      password: isJump ? q('#pfPass2').value : q('#pfPass').value,
      auth: isJump ? q('#pfAuth').value : 'password',
      key_path: isJump ? q('#pfKeyPath').value.trim() : ''
    };
  }
}

export function initServers() {
  $('#btnAddHost').addEventListener('click', () => hostModal());
  // 统一在栏容器上绑定一次（避免每次重绘树时重复叠加监听器）
  $('#serversCol').addEventListener('contextmenu', (e) => {
    if (e.target.closest('button, .tree-server, .tree-group-head')) return;
    e.preventDefault();
    blankCtx(e);
  });
}
