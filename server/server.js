'use strict';
/**
 * 直播中枢 livestream-hub
 * ------------------------------------------------------------------
 * 职责:
 *   1. 对观众提供唯一入口链接: 自动探测是否在校园网内 -> 分流到局域网直连或隧道
 *   2. 真名白名单门禁 (names.txt 热加载)
 *   3. 多用户聊天: 观众之间互相可见、可回复; 主机端只读展示
 *   4. 反向代理 MediaMTX 的 HLS / WHEP, 并统计走隧道的流量(樱花额度)
 *
 * 端口: 只监听 7000/TCP (局域网 + 樱花隧道都指到这里)
 * ------------------------------------------------------------------
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------- 路径
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const WEB_DIR = path.join(ROOT, 'web');
const LOG_DIR = path.join(ROOT, 'logs');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const NAMES_FILE = path.join(DATA_DIR, 'names.txt');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.jsonl');
const SERVER_LOG = path.join(LOG_DIR, 'server.log');

// ---------------------------------------------------------------- 常量
const MAX_MSG_LEN = 300;
const MIN_MSG_INTERVAL_MS = 1000;
const HISTORY_KEEP = 300;
const HISTORY_SEND = 60;
const SESSION_TTL_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------- 工具
function pad(n) { return String(n).padStart(2, '0'); }
function nowIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function monthKey() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }

function log(...args) {
  const line = `[${nowIso()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(SERVER_LOG, line + '\n'); } catch (_) { /* ignore */ }
}

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return def; }
}
function saveJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (e) { log('saveJSON 失败', file, e.message); }
}

// ---------------------------------------------------------------- 配置(热加载)
let cfg = loadJSON(CONFIG_FILE, {});
let cfgMtime = 0;
function reloadConfig(force) {
  try {
    const st = fs.statSync(CONFIG_FILE);
    if (!force && st.mtimeMs === cfgMtime) return;
    cfgMtime = st.mtimeMs;
    cfg = loadJSON(CONFIG_FILE, {});
    log('配置已重新加载');
  } catch (_) { /* 保持旧配置 */ }
}
function C(key, def) { return cfg[key] !== undefined ? cfg[key] : def; }

// ---------------------------------------------------------------- 白名单(热加载)
let names = [];
let namesMtime = 0;
function reloadNames(force) {
  try {
    const st = fs.statSync(NAMES_FILE);
    if (!force && st.mtimeMs === namesMtime) return;
    namesMtime = st.mtimeMs;
    names = fs.readFileSync(NAMES_FILE, 'utf8')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'));
    log(`白名单已加载: ${names.length} 人`);
  } catch (e) { log('白名单读取失败:', e.message); }
}
function nameAllowed(name) {
  if (!name) return false;
  // 全角空格等归一化
  const n = name.replace(/[\u3000\s]+/g, ' ').trim();
  return names.some(x => x === n);
}

// ---------------------------------------------------------------- 网卡 / 局域网地址
function ifaceList() {
  const out = [];
  const exclude = C('excludeIfaces', []);
  const include = C('lanIfaces', []);
  const all = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(all)) {
    if (include.length && !include.some(p => name.includes(p))) continue;
    if (!include.length && exclude.some(p => name.includes(p))) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      out.push({ iface: name, ip: a.address, netmask: a.netmask });
    }
  }
  return out;
}
function lanUrls() {
  const port = C('port', 7000);
  return ifaceList().map(i => ({ iface: i.iface, ip: i.ip, url: `http://${i.ip}:${port}` }));
}
function ipToInt(ip) { return ip.split('.').reduce((n, o) => (n << 8) + (Number(o) & 255), 0) >>> 0; }
function isLanIp(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1') return true;
  const clean = ip.replace(/^::ffff:/, '');
  for (const i of ifaceList()) {
    try {
      const mask = ipToInt(i.netmask);
      if ((ipToInt(clean) & mask) === (ipToInt(i.ip) & mask)) return true;
    } catch (_) { /* ignore */ }
  }
  return false;
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const raw = (xff ? String(xff).split(',')[0] : (req.socket.remoteAddress || '')).trim();
  return raw.replace(/^::ffff:/, '') || 'unknown';
}

// ---------------------------------------------------------------- 会话
let sessions = new Map(Object.entries(loadJSON(SESSIONS_FILE, {})));
function saveSessions() {
  const obj = {};
  for (const [k, v] of sessions) obj[k] = v;
  saveJSON(SESSIONS_FILE, obj);
}
function newSession(name, via, ip) {
  const token = crypto.randomBytes(16).toString('hex');
  const s = { name, via, ip, joinedAt: Date.now(), lastSeen: Date.now(), lagMs: 0, msgCount: 0 };
  sessions.set(token, s);
  saveSessions();
  return { token, session: s };
}
function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - (s.lastSeen || 0) > SESSION_TTL_MS) { sessions.delete(token); saveSessions(); return null; }
  s.lastSeen = Date.now();
  return s;
}

// ---------------------------------------------------------------- 流量统计(按月)
let stats = loadJSON(STATS_FILE, { months: {} });
function monthBucket() {
  const k = monthKey();
  if (!stats.months[k]) stats.months[k] = { wanBytes: 0, lanBytes: 0, byPath: {} };
  return stats.months[k];
}
let statsDirty = false;
function addBytes(kind, bytes, p) {
  const b = monthBucket();
  if (kind === 'wan') b.wanBytes += bytes; else b.lanBytes += bytes;
  b.byPath[p] = (b.byPath[p] || 0) + bytes;
  statsDirty = true;
}
function statsSnapshot() {
  const b = monthBucket();
  const quota = Number(C('quotaGB', 16)) * 1024 * 1024 * 1024;
  return {
    month: monthKey(),
    wanBytes: b.wanBytes,
    lanBytes: b.lanBytes,
    quotaBytes: quota,
    percent: quota > 0 ? b.wanBytes / quota : 0,
    online: wss ? wss.clients.size : 0,
    uptimeSec: Math.floor((Date.now() - START_AT) / 1000)
  };
}

// ---------------------------------------------------------------- 聊天历史
// 需求：每次开播聊天都从空的开始，服务一关聊天就没了。
// 两条清空触发路径：
//   1) 服务启动时（除非 config.json 里把 clearChatOnStart 设成 false）
//   2) 推流从离线变成在线时 —— 服务一直开着也能做到"每开播一次清一次"
let history = [];
function appendChat(msg) {
  history.push(msg);
  if (history.length > HISTORY_KEEP) history.splice(0, history.length - HISTORY_KEEP);
  try { fs.appendFileSync(CHAT_FILE, JSON.stringify(msg) + '\n'); } catch (_) { /* ignore */ }
}

function clearChat(reason) {
  const had = history.length;
  history = [];
  try { fs.writeFileSync(CHAT_FILE, ''); } catch (_) { /* ignore */ }
  try { broadcast({ t: 'cleared', reason: reason || '' }); } catch (_) { /* wss 还没起来 */ }
  if (had) log(`聊天已清空（${reason}），原有 ${had} 条`);
  return had;
}

function initHistory() {
  if (C('clearChatOnStart', true)) {
    clearChat('服务启动');
    log('启动时已清空聊天（clearChatOnStart = true）');
  } else {
    try {
      const lines = fs.readFileSync(CHAT_FILE, 'utf8').trim().split(/\r?\n/);
      history = lines.slice(-HISTORY_KEEP).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      log(`聊天历史已加载: ${history.length} 条`);
    } catch (_) { history = []; }
  }
}

// 盯住 MediaMTX 的原始推流路径：离线 -> 在线 就认为"又开播了一次"
let liveWasOnline = null;
async function watchStreamState() {
  try {
    const host = C('mediamtxHost', '127.0.0.1');
    const r = await fetch(`http://${host}:9997/v3/paths/list`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const rawName = C('streamPaths', {}).raw || 'live';
    const live = (j.items || []).find(x => x.name === rawName);
    const online = !!(live && live.online);
    if (liveWasOnline === false && online === true) clearChat('检测到新的推流');
    liveWasOnline = online;
  } catch (_) { /* MediaMTX 没起来就先不管 */ }
}

// ---------------------------------------------------------------- 静态文件
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};
function serveStatic(req, res, rel) {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(WEB_DIR, safe);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 ' + rel); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 反代 MediaMTX
// MediaMTX 返回的 Cookie 带 Secure/Partitioned, 纯 HTTP 下浏览器会拒收,
// 这里降级成浏览器肯存的形态 (SameSite=None 必须配 Secure, 所以一并降为 Lax)
function sanitizeCookie(c) {
  return String(c)
    .replace(/;\s*Secure/gi, '')
    .replace(/;\s*Partitioned/gi, '')
    .replace(/SameSite=None/gi, 'SameSite=Lax');
}

// MediaMTX 的 HLS 会话靠 cookie 串联(播放列表 -> 变体列表 -> 分片),
// 而它下发的 cookie 带 Secure, 纯 HTTP 环境存不住。
// 所以由代理统一托管会话 cookie, 客户端一个 cookie 都不需要。
const cookieJar = new Map();          // clientKey -> "name=value; name2=value2"
const cookieJarAt = new Map();
function jarKey(req) { return clientIp(req) + '|' + (req.headers['user-agent'] || ''); }
function jarGet(req) { return cookieJar.get(jarKey(req)) || ''; }
function jarMerge(req, setCookies) {
  const k = jarKey(req);
  const m = new Map();
  for (const part of jarGet(req).split(';')) {
    const t = part.trim();
    if (t.includes('=')) m.set(t.split('=')[0].trim(), t);
  }
  for (const sc of [].concat(setCookies || [])) {
    const first = String(sc).split(';')[0].trim();
    if (first.includes('=')) m.set(first.split('=')[0].trim(), first);
  }
  cookieJar.set(k, [...m.values()].join('; '));
  cookieJarAt.set(k, Date.now());
}
setInterval(() => {
  const cut = Date.now() - 3600 * 1000;
  for (const [k, t] of cookieJarAt) if (t < cut) { cookieJar.delete(k); cookieJarAt.delete(k); }
}, 300000);

// 客户端线路记忆: 播放列表请求会带 ?via=lan|wan, 但 hls.js 解析分片时
// 会把查询串丢掉, 所以要把线路"粘"在这个客户端身上, 后续分片才计得准。
// 流量额度统计依赖它, 不能只按 path 名猜。
const clientRoute = new Map();          // jarKey -> {via, at}
const ROUTE_TTL_MS = 10 * 60 * 1000;
function markRoute(req, via) { clientRoute.set(jarKey(req), { via, at: Date.now() }); }
function routeOf(req, fallback) {
  const r = clientRoute.get(jarKey(req));
  if (r && Date.now() - r.at < ROUTE_TTL_MS) return r.via;
  return fallback;
}

function proxyToMediaMTX(req, res, remotePath, upstreamPort, counter, pathName, prefix, retried) {
  const host = C('mediamtxHost', '127.0.0.1');
  const headers = Object.assign({}, req.headers);
  headers.host = `${host}:${upstreamPort}`;
  const jar = jarGet(req);
  if (jar) headers.cookie = jar;

  const up = http.request({ host, port: upstreamPort, method: req.method, path: remotePath, headers }, (upRes) => {
    if (upRes.headers['set-cookie']) jarMerge(req, upRes.headers['set-cookie']);

    // MediaMTX 的防热链握手: 302 到 <path>?cookieCheck=1。代理内部跟随一次,
    // 客户端只看到最终结果, 不会陷入重定向死循环。
    const canRetry = !retried && (req.method === 'GET' || req.method === 'HEAD');
    if (canRetry && upRes.statusCode === 302 && upRes.headers.location) {
      const loc = upRes.headers.location;
      upRes.resume();                                   // 丢弃这次响应体
      return proxyToMediaMTX(req, res, loc, upstreamPort, counter, pathName, prefix, true);
    }

    const outHeaders = Object.assign({}, upRes.headers);
    delete outHeaders['content-length'];                // 边转发边计数, 长度交给 chunked
    delete outHeaders['transfer-encoding'];
    delete outHeaders['set-cookie'];                    // 会话 cookie 由代理托管, 不下发给客户端
    if (outHeaders.location && outHeaders.location.startsWith('/') && !outHeaders.location.startsWith(prefix + '/')) {
      outHeaders.location = prefix + outHeaders.location;   // 补回 /hls 或 /whep 前缀
    }
    outHeaders['access-control-allow-origin'] = '*';
    res.writeHead(upRes.statusCode, outHeaders);
    upRes.on('data', (chunk) => { addBytes(counter, chunk.length, pathName); });
    upRes.pipe(res);
  });

  up.on('error', (e) => {
    log(`反代失败 ${remotePath}: ${e.message}`);
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); }
    res.end('MediaMTX 不可达 (' + e.code + ') — 请确认 mediamtx 已启动');
  });

  if (req.method === 'GET' || req.method === 'HEAD') up.end();
  else req.pipe(up);
}

// ---------------------------------------------------------------- HTTP 服务
const START_AT = Date.now();
const PORT = Number(process.env.PORT || cfg.port || 7000);

function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { data = data.slice(0, limit); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  reloadConfig(); reloadNames();
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const ip = clientIp(req);
  const lan = isLanIp(ip);

  // ---- 健康探测 (入口页用它判断局域网是否可达) ----
  if (p === '/probe') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end('ok');
  }

  // ---- 局域网候选地址 (由入口页从隧道侧拉取) ----
  if (p === '/routes.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ port: C('port', 7000), lan: lanUrls(), probeTimeoutMs: C('lanProbeTimeoutMs', 800) }));
  }

  if (p === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      port: C('port', 7000),
      streamPaths: C('streamPaths', { lan: 'live', wan: 'wan' }),
      video: C('video', { lan: 'webrtc', wan: 'hls' }),
      lanUrls: lanUrls()
    }));
  }

  // ---- 加入: 真名校验 ----
  if (p === '/api/join' && req.method === 'POST') {
    const body = await readBody(req);
    let name = '', declaredVia = '';
    try { const j = JSON.parse(body); name = (j.name || '').trim(); declaredVia = String(j.via || ''); } catch (_) { /* ignore */ }
    if (!name) return json(res, 400, { ok: false, error: '请输入你的名字' });
    if (name.length > 20) return json(res, 400, { ok: false, error: '名字过长' });
    if (!nameAllowed(name)) {
      log(`拒绝进入: "${name}" (${ip}) 不在白名单`);
      return json(res, 403, { ok: false, error: '名字错误：名单里没有这个名字，请填写你的真实姓名' });
    }
    // 走 TCP 隧道时, 所有外网观众的来源 IP 在服务端看都是 127.0.0.1,
    // 没法用 IP 判断内外网 —— 以入口页自己探测出来的线路为准。
    let via = (declaredVia === 'lan' || declaredVia === 'wan') ? declaredVia : (lan ? 'lan' : 'wan');
    const { token, session } = newSession(name, via, ip);
    log(`准入: ${name} via=${via}${declaredVia ? '(客户端声明)' : '(IP推断)'} ip=${ip}`);
    return json(res, 200, { ok: true, token, name: session.name, via });
  }

  // ---- 会话查询 ----
  if (p === '/api/me') {
    const t = u.searchParams.get('token') || '';
    const s = getSession(t);
    if (!s) return json(res, 401, { ok: false, error: '会话已失效，请重新进入' });
    // 名字必须"此刻"仍在白名单里。否则改了名单之后，旧 token 还能一直免检进入。
    if (!nameAllowed(s.name)) {
      sessions.delete(t); saveSessions();
      log(`会话作废: "${s.name}" 已不在白名单`);
      return json(res, 401, { ok: false, error: '你的名字已不在名单里，请联系主讲人核对' });
    }
    return json(res, 200, { ok: true, name: s.name, via: s.via });
  }

  // ---- 流量统计 ----
  if (p === '/api/stats') {
    return json(res, 200, statsSnapshot());
  }

  // ---- 浏览器自检回传 (只写日志, 供排查 WebRTC/播放链路用) ----
  if (p === '/api/selftest' && req.method === 'POST') {
    const body = await readBody(req, 8192);
    log(`[自检] ${body}`);
    return json(res, 200, { ok: true });
  }

  // ---- 手动清空聊天（主机用，需持 hostKey）----
  if (p === '/api/clear-chat' && req.method === 'POST') {
    const key = C('hostKey', '');
    if (!key || u.searchParams.get('key') !== key) {
      return json(res, 403, { ok: false, error: 'forbidden' });
    }
    const n = clearChat('手动清空');
    return json(res, 200, { ok: true, cleared: n });
  }

  // ---- 媒体反代 ----
  // 端口看协议(8888=HLS, 8889=WebRTC);
  // 流量计数器以客户端申报的线路为准(走 TCP 隧道时服务端看不出内外网),
  // 没申报才退回按 path 名猜。
  const viaParam = u.searchParams.get('via');
  if (viaParam === 'lan' || viaParam === 'wan') markRoute(req, viaParam);
  if (p.startsWith('/hls/')) {
    const rest = p.slice(5).replace(/^\/+/, '');
    const pathName = rest.split('/')[0] || '';
    const counter = routeOf(req, pathName === C('streamPaths', {}).wan ? 'wan' : 'lan');
    return proxyToMediaMTX(req, res, '/' + rest + (u.search || ''),
      C('hlsPort', 8888), counter, pathName, '/hls');
  }
  if (p.startsWith('/whep/')) {
    const rest = p.slice(6).replace(/^\/+/, '');
    const pathName = rest.split('/')[0] || '';
    const counter = routeOf(req, pathName === C('streamPaths', {}).wan ? 'wan' : 'lan');
    return proxyToMediaMTX(req, res, '/' + rest + (u.search || ''),
      C('webrtcPort', 8889), counter, pathName, '/whep');
  }

  // ---- 页面 ----
  if (p === '/' || p === '/index.html') return serveStatic(req, res, 'index.html');
  if (p === '/watch') return serveStatic(req, res, 'watch.html');
  if (p === '/host') return serveStatic(req, res, 'host.html');
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  return serveStatic(req, res, p.replace(/^\/+/, ''));
});

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------- WebSocket 聊天
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/chat') { socket.destroy(); return; }
  const token = u.searchParams.get('token') || '';

  // 主机端只读窗口: 必须持 hostKey。
  // 注意: 走 TCP 隧道时外网观众在服务端看也是 127.0.0.1, 所以不能给本机开后门,
  // 否则任何人都能通过隧道直接打开主机消息窗。
  if (u.searchParams.get('host') === '1') {
    const key = C('hostKey', '');
    if (!key || token !== key) {
      log(`拒绝主机窗口连接: key 不匹配 (ip=${clientIp(req)})`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isHost = true;
      ws.session = { name: 'HOST', via: 'lan' };
      wss.emit('connection', ws, req);
    });
    return;
  }

  const session = getSession(token);
  // 同样要复查白名单: 名单改过之后旧 token 不能继续用
  if (!session || !nameAllowed(session.name)) {
    if (session) { sessions.delete(token); saveSessions(); log(`会话作废(WS): "${session.name}" 不在白名单`); }
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.token = token;
    ws.session = session;
    ws.isHost = false;
    wss.emit('connection', ws, req);
  });
});

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) { if (c.readyState === 1) c.send(s); }
}
function pushPresence() {
  const users = [];
  for (const c of wss.clients) if (!c.isHost && c.session) users.push(c.session.name);
  broadcast({ t: 'presence', online: users.length, users: [...new Set(users)] });
}

wss.on('connection', (ws) => {
  const s = ws.session;
  ws.send(JSON.stringify({
    t: 'hello',
    name: s.name,
    via: s.via,
    isHost: !!ws.isHost,
    history: history.slice(-HISTORY_SEND),
    stats: statsSnapshot()
  }));
  pushPresence();

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }

    if (m.t === 'lag') {
      s.lagMs = Math.max(0, Math.min(30000, Number(m.ms) || 0));
      return;
    }

    if (m.t === 'msg') {
      if (ws.isHost) return;                                     // 主机端只读
      const text = String(m.text || '').replace(/\s+$/, '').trim();
      if (!text) return;
      if (text.length > MAX_MSG_LEN) return;
      const now = Date.now();
      if (now - (s.lastMsgAt || 0) < MIN_MSG_INTERVAL_MS) {
        ws.send(JSON.stringify({ t: 'warn', text: '发得太快了，缓一下' }));
        return;
      }
      s.lastMsgAt = now;
      s.msgCount = (s.msgCount || 0) + 1;
      const msg = {
        id: crypto.randomBytes(4).toString('hex'),
        name: s.name,
        text,
        ts: now,
        via: s.via,
        lagMs: s.lagMs || 0
      };
      appendChat(msg);
      broadcast({ t: 'msg', ...msg });
      return;
    }
  });

  ws.on('close', () => { pushPresence(); });
  ws.on('error', () => { /* ignore */ });
});

// ---------------------------------------------------------------- 定时任务
setInterval(() => {
  if (statsDirty) { saveJSON(STATS_FILE, stats); statsDirty = false; }
}, 20000);

setInterval(() => {
  // 会话过期清理
  let changed = false;
  for (const [k, v] of sessions) {
    if (Date.now() - (v.lastSeen || 0) > SESSION_TTL_MS) { sessions.delete(k); changed = true; }
  }
  if (changed) saveSessions();
  broadcast({ t: 'stats', ...statsSnapshot() });
}, 15000);

// ---------------------------------------------------------------- 启动
reloadConfig(true);
reloadNames(true);
initHistory();
// 每次开播都让人重新报一次名字，否则旧 token 会绕开白名单
if (C('clearSessionsOnStart', true) && sessions.size) {
  const n = sessions.size;
  sessions.clear(); saveSessions();
  log(`已清空 ${n} 个旧会话（clearSessionsOnStart = true），观众需重新验证名字`);
}
// 每 5 秒看一次推流状态，开播时自动清空聊天
setInterval(watchStreamState, 5000);
watchStreamState();

server.listen(PORT, '0.0.0.0', () => {
  log('==============================================');
  log(`直播中枢已启动, 监听 0.0.0.0:${PORT}`);
  const urls = lanUrls();
  if (urls.length) urls.forEach(x => log(`  局域网入口: ${x.url}  (${x.iface})`));
  else log('  ⚠ 未识别到局域网网卡, 请检查 data/config.json 的 lanIfaces');
  log(`  白名单人数: ${names.length}`);
  log(`  本月隧道流量额度: ${C('quotaGB', 16)} GB`);
  log(`  主机消息窗(本机打开): http://127.0.0.1:${PORT}/host?key=${C('hostKey', '')}`);
  log('==============================================');
});

process.on('uncaughtException', (e) => log('未捕获异常:', e.stack || e.message));
process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝:', e && (e.stack || e.message)));
