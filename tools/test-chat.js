// 聊天链路自测：门禁 -> 会话 -> WebSocket 收发 -> 主机只读窗口
//
// 用法（先把服务跑起来）：
//     cd <项目>\server
//     node ..\tools\test-chat.js
//
// 依赖 server\node_modules 里的 ws（setup.ps1 会装好）
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BASE = `http://127.0.0.1:${(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')).port) || 7000}`;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));

const names = fs.readFileSync(path.join(ROOT, 'data', 'names.txt'), 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
if (names.length < 2) {
  console.error('❌ data\\names.txt 里至少要有两个名字才能跑这个测试（先用 setup.ps1 生成的示例名单也行）');
  process.exit(2);
}
const [NAME_A, NAME_B] = names;

const WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws'));

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

function connect(token, hostFlag) {
  const url = `ws://127.0.0.1:${cfg.port || 7000}/chat?token=${encodeURIComponent(token)}${hostFlag ? '&host=1' : ''}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs = [];
    ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch (_) {} });
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS 连接超时')), 5000);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
    ok ? pass++ : fail++;
  };

  const bad = await post('/api/join', { name: '__definitely_not_on_the_list__' });
  check('白名单外的名字被拒绝', bad.status === 403, `HTTP ${bad.status}`);

  const good = await post('/api/join', { name: NAME_A, via: 'wan' });
  check(`白名单内的名字通过 (${NAME_A})`, good.status === 200 && good.json.ok === true);
  check('客户端申报的线路被采纳', good.json.via === 'wan', `via=${good.json.via}`);

  const me = await fetch(`${BASE}/api/me?token=${good.json.token}`).then(r => r.json());
  check('会话可查询', me.ok === true && me.name === NAME_A, `name=${me.name}`);

  let rejected = false;
  try { await connect('badtoken', false); } catch (_) { rejected = true; }
  check('伪造 token 的 WebSocket 被拒绝', rejected);

  let hostRejected = false;
  try { await connect('wrong-key', true); } catch (_) { hostRejected = true; }
  check('错误 hostKey 的主机窗口被拒绝', hostRejected);

  const a = await connect(good.json.token, false);
  const bJoin = await post('/api/join', { name: NAME_B });
  const b = await connect(bJoin.json.token, false);
  const host = await connect(cfg.hostKey, true);
  await wait(300);

  a.ws.send(JSON.stringify({ t: 'msg', text: `大家好，我是${NAME_A}` }));
  await wait(400);
  check('另一个观众能看到消息（互相可见）', b.msgs.filter(m => m.t === 'msg' && m.text.includes(NAME_A)).length === 1);
  check('主机窗口能看到消息', host.msgs.filter(m => m.t === 'msg' && m.text.includes(NAME_A)).length === 1);

  const before = b.msgs.length;
  host.ws.send(JSON.stringify({ t: 'msg', text: '主机不该能发言' }));
  await wait(400);
  check('主机窗口发送被忽略（只读）', !b.msgs.slice(before).some(m => m.t === 'msg' && m.text.includes('主机不该')));

  a.ws.send(JSON.stringify({ t: 'msg', text: '连发1' }));
  a.ws.send(JSON.stringify({ t: 'msg', text: '连发2' }));
  await wait(400);
  const warned = a.msgs.some(m => m.t === 'warn');
  const flooded = b.msgs.filter(m => m.t === 'msg' && m.text.startsWith('连发')).length;
  check('1 秒内连发被限流', warned && flooded <= 1, `送达 ${flooded} 条`);

  const pres = b.msgs.filter(m => m.t === 'presence').pop();
  check('在线人数广播正确', !!pres && pres.online >= 2, JSON.stringify(pres || null));

  a.ws.send(JSON.stringify({ t: 'lag', ms: 2200 }));
  await wait(200);
  a.ws.send(JSON.stringify({ t: 'msg', text: '带上延迟信息' }));
  await wait(400);
  const withLag = host.msgs.filter(m => m.t === 'msg' && m.text === '带上延迟信息').pop();
  check('延迟补偿字段随消息下发', !!withLag && withLag.lagMs === 2200, `lagMs=${withLag && withLag.lagMs}`);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  a.ws.close(); b.ws.close(); host.ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(2); });
