// 管理功能自测：禁言 / 解除禁言 / 踢人（踢出必须连画面一起断） + 入口页 esc() 回归
//
// 用法（先把服务跑起来）：
//     cd <项目>\server
//     node ..\tools\test-mod.js
//
// 依赖 server\node_modules 里的 ws（setup.ps1 会装好）
//
// ⚠ 这个脚本会**真的**用名单里的前两个名字进入、并真的踢掉其中一个。
//   正在直播、有人看的时候不要在正式实例上跑 —— 先把服务停掉，
//   或者拷一份项目出来在别的端口上跑。
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const PORT = cfg.port || 7000;
const BASE = `http://127.0.0.1:${PORT}`;
const WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws'));

const names = fs.readFileSync(path.join(ROOT, 'data', 'names.txt'), 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
if (names.length < 3) {
  console.error('❌ data\\names.txt 里至少要有三个名字才能跑这个测试（第三个用来测"踢不在线的人"）');
  process.exit(2);
}
const [NAME_A, NAME_B, NAME_IDLE] = names;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  <<< ' + extra : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const last = (bag, t) => [...bag].reverse().find(m => m.t === t);

async function join(name, extra) {
  const r = await fetch(BASE + '/api/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ name, via: 'lan' }, extra || {}))
  });
  let body = null; try { body = await r.json(); } catch (_) {}
  let cookie = '';
  try { cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).filter(Boolean).join('; '); } catch (_) {}
  return { status: r.status, body, cookie };
}

// 媒体请求：能被授权就不是 401/403（流本身在不在是另一回事）
async function media(pathAndQuery, cookie) {
  const headers = {};
  if (cookie) headers.cookie = cookie.split(';')[0];
  const r = await fetch(BASE + pathAndQuery, { headers });
  return r.status;
}
const HLS_PLAYLIST = '/hls/wan/index.m3u8';

function connect(token, hostFlag) {
  const url = `ws://127.0.0.1:${PORT}/chat?token=${encodeURIComponent(token)}${hostFlag ? '&host=1' : ''}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const bag = [];
    ws.on('message', (d) => { try { bag.push(JSON.parse(d.toString())); } catch (_) {} });
    ws.on('open', () => resolve({ ws, bag }));
    ws.on('error', reject);
  });
}

(async () => {
  console.log(`目标: ${BASE}   白名单人数: ${names.length}`);

  // ---- 0. 入口页 esc() 回归（v1.0.3 就是这里崩的）----
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const used = (html.match(/[^.\w]esc\(/g) || []).length;
  ok(/function\s+esc\s*\(/.test(html), 'web/index.html 里定义了 esc()');
  ok(!(used > 0 && !/function\s+esc\s*\(/.test(html)), `index.html 用了 ${used} 次 esc() 且都有定义`);

  // ---- 1. 错误名字被拒（这条错误信息正好走 esc() 渲染）----
  const bad = await join('查无此人-' + Date.now());
  ok(bad.status === 403 && /真实姓名/.test(String(bad.body && bad.body.error)),
     '错误名字被拒，且返回可读中文错误', JSON.stringify(bad.body));

  // ---- 2. 媒体必须带凭据 ----
  const noTok = await media(HLS_PLAYLIST + '');
  ok(noTok === 401, '没有凭据的媒体请求被拒（401）', 'status=' + noTok);
  const wrongTok = await media(HLS_PLAYLIST + '?token=deadbeef');
  ok(wrongTok === 401, '伪造 token 的媒体请求被拒（401）', 'status=' + wrongTok);

  // ---- 3. 两个人进来 ----
  const ja = await join(NAME_A), jb = await join(NAME_B);
  ok(ja.status === 200 && jb.status === 200, `两人进入成功 (${NAME_A} / ${NAME_B})`);
  const goodMedia = await media(HLS_PLAYLIST + '?token=' + ja.body.token);
  ok(goodMedia !== 401 && goodMedia !== 403, '带合法 token 的媒体请求能通过', 'status=' + goodMedia);
  const goodMediaCookie = await media(HLS_PLAYLIST, ja.cookie);
  ok(goodMediaCookie !== 401 && goodMediaCookie !== 403, '带合法 cookie 的媒体请求能通过（hls.js 分片走这条路）',
     'status=' + goodMediaCookie + ' cookie=' + JSON.stringify(ja.cookie));

  const A = await connect(ja.body.token);
  const B = await connect(jb.body.token);
  const H = await connect(cfg.hostKey, true);
  await sleep(400);

  const ph = last(H.bag, 'presence');
  ok(ph && ph.online === 2, '主机看到 2 人在线', JSON.stringify(ph && ph.online));
  ok(ph && (ph.detail || []).every(u => u.muted === false), 'presence.detail 带 muted 字段（初始 false）');

  // ---- 4. 观众不能冒充主机 ----
  A.ws.send(JSON.stringify({ t: 'mod', action: 'kick', name: NAME_B }));
  await sleep(300);
  ok(B.ws.readyState === 1 && !last(B.bag, 'kicked'), '观众伪造的管理指令无效');

  // ---- 5. 禁言 ----
  H.bag.length = 0;
  H.ws.send(JSON.stringify({ t: 'mod', action: 'mute', name: NAME_B }));
  await sleep(400);
  ok(last(B.bag, 'muted') && last(B.bag, 'muted').muted === true, 'B 收到 muted=true');
  ok(!!last(H.bag, 'sys'), '主机收到系统提示', JSON.stringify(last(H.bag, 'sys')));
  ok(!!last(A.bag, 'sys'), '其他观众也能看到系统提示');
  const ph2 = last(H.bag, 'presence');
  ok(ph2 && ph2.detail.find(u => u.name === NAME_B && u.muted === true), 'presence 里 B 标成已禁言');

  // ---- 6. 被禁言的人发不出消息 ----
  B.bag.length = 0; A.bag.length = 0;
  B.ws.send(JSON.stringify({ t: 'msg', text: '我还能说话吗' }));
  await sleep(400);
  ok(/禁言/.test(String((last(B.bag, 'warn') || {}).text)), 'B 发言被拦并收到 warn');
  ok(!A.bag.some(m => m.t === 'msg'), 'A 没收到被禁言者的消息');

  // ---- 7. 解除禁言 ----
  B.bag.length = 0; A.bag.length = 0;
  H.ws.send(JSON.stringify({ t: 'mod', action: 'unmute', name: NAME_B }));
  await sleep(400);
  ok(last(B.bag, 'muted') && last(B.bag, 'muted').muted === false, 'B 收到 muted=false');
  B.ws.send(JSON.stringify({ t: 'msg', text: '解禁之后第一句' }));
  await sleep(400);
  ok(A.bag.some(m => m.t === 'msg' && m.text === '解禁之后第一句'), '解禁后 B 能正常发言');

  // ---- 8. 第一次踢人：连接断、会话废、画面断，但**允许重新进** ----
  H.bag.length = 0;
  let aClosed = false;
  A.ws.on('close', () => { aClosed = true; });
  H.ws.send(JSON.stringify({ t: 'mod', action: 'kick', name: NAME_A }));
  await sleep(700);
  ok(aClosed && A.ws.readyState === 3, 'A 的连接被断开', 'readyState=' + A.ws.readyState);
  const kickMsg = last(A.bag, 'kicked');
  ok(kickMsg && kickMsg.count === 1 && kickMsg.banned === false, 'A 收到"第 1 次移出"且未被禁足',
     JSON.stringify(kickMsg));
  ok(/移出/.test(String((last(H.bag, 'sys') || {}).text)), '主机收到踢人回执');

  const meA = await fetch(BASE + '/api/me?token=' + encodeURIComponent(ja.body.token));
  ok(meA.status === 401, '被踢者的旧会话已作废（/api/me 401）', 'status=' + meA.status);
  const mediaA = await media(HLS_PLAYLIST + '?token=' + ja.body.token);
  ok(mediaA === 403, '被踢者旧 token 的媒体请求被拒（403）—— 画面真的断了', 'status=' + mediaA);
  const mediaACookie = await media(HLS_PLAYLIST, ja.cookie);
  ok(mediaACookie === 403, '被踢者带 cookie 的媒体请求一样被拒（403）', 'status=' + mediaACookie);
  const rejoinA = await join(NAME_A);
  ok(rejoinA.status === 200, '第 1 次被踢后还能重新输名字进来（不是一次就拉黑）', JSON.stringify(rejoinA.body));
  const ph3 = last(H.bag, 'presence');
  ok(ph3 && ph3.online === 1, '踢掉后在线人数=1', JSON.stringify(ph3 && ph3.online));
  ok(ph3 && (ph3.kicked || []).some(u => u.name === NAME_A && u.count === 1 && !u.banned),
     'presence.kicked 里记着"第 1 次"且未禁足', JSON.stringify(ph3 && ph3.kicked));

  // ---- 9. 第二、三次：连续够 3 次才禁足本场 ----
  const ja2 = await join(NAME_A);
  const A2 = await connect(ja2.body.token);
  await sleep(300);
  H.bag.length = 0;
  H.ws.send(JSON.stringify({ t: 'mod', action: 'kick', name: NAME_A }));
  await sleep(600);
  const k2 = last(A2.bag, 'kicked');
  ok(k2 && k2.count === 2 && k2.banned === false, '第 2 次移出仍未禁足', JSON.stringify(k2));
  ok((await join(NAME_A)).status === 200, '第 2 次之后仍可重进');
  const ja3 = await join(NAME_A);
  const A3 = await connect(ja3.body.token);
  await sleep(300);
  H.bag.length = 0;
  H.ws.send(JSON.stringify({ t: 'mod', action: 'kick', name: NAME_A }));
  await sleep(700);
  const k3 = last(A3.bag, 'kicked');
  ok(k3 && k3.count === 3 && k3.banned === true, '第 3 次移出 → 禁足本场', JSON.stringify(k3));
  const rejoinA3 = await join(NAME_A);
  ok(rejoinA3.status === 403 && /移出/.test(String(rejoinA3.body && rejoinA3.body.error)),
     '第 3 次之后重新报名被拒', JSON.stringify(rejoinA3.body));
  const ph5 = last(H.bag, 'presence');
  ok(ph5 && (ph5.kicked || []).some(u => u.name === NAME_A && u.banned === true),
     'presence.kicked 标成已禁足', JSON.stringify(ph5 && ph5.kicked));

  // ---- 10. 清零放行 ----
  H.bag.length = 0;
  H.ws.send(JSON.stringify({ t: 'mod', action: 'unkick', name: NAME_A }));
  await sleep(400);
  const ph4 = last(H.bag, 'presence');
  ok(ph4 && !(ph4.kicked || []).some(u => u.name === NAME_A), '清零后 presence.kicked 里不再有 A');
  const rejoinA2 = await join(NAME_A);
  ok(rejoinA2.status === 200, '清零之后可以用真名重新进入', JSON.stringify(rejoinA2.body));
  if (rejoinA2.status === 200) {
    const mediaA2 = await media(HLS_PLAYLIST + '?token=' + rejoinA2.body.token);
    ok(mediaA2 !== 401 && mediaA2 !== 403, '重新进入后媒体请求恢复正常', 'status=' + mediaA2);
  }

  // ---- 11. 踢一个不在线的人：同样记次数 ----
  H.bag.length = 0;
  H.ws.send(JSON.stringify({ t: 'mod', action: 'kick', name: NAME_IDLE }));
  await sleep(400);
  const sysIdle = last(H.bag, 'sys');
  ok(/第 1 次/.test(String(sysIdle && sysIdle.text)), '踢不在线的人也记一次', JSON.stringify(sysIdle));
  ok((await join(NAME_IDLE)).status === 200, '只被踢 1 次的人仍能进来（没被误伤）');
  H.ws.send(JSON.stringify({ t: 'mod', action: 'unkick', name: NAME_IDLE }));   // 收尾
  await sleep(300);

  [B.ws, H.ws].forEach(w => { try { w.close(); } catch (_) {} });
  await sleep(200);

  console.log(`\n${fail ? '❌' : '✅'} 结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试脚本异常:', e); process.exit(2); });
