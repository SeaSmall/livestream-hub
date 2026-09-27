/* 顺着 HLS 的取流链路走一遍：主播放列表 -> 变体列表 -> 分片
   模拟播放器的解析方式（相对地址按 manifest 的地址解析），把每一步的状态码和地址打出来。
   用法: node tools/test-hls-chain.js [入口地址] [名字] [路径]
        路径默认 wan（外网观众走的那条） */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));

const BASE = (process.argv[2] || `http://127.0.0.1:${cfg.port || 7000}`).replace(/\/+$/, '');
const NAME = process.argv[3] || '手机测试';
const P = process.argv[4] || 'wan';

(async () => {
  const jr = await fetch(BASE + '/api/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, via: 'wan' })
  });
  const jj = await jr.json();
  if (!jj.ok) { console.log('报名失败:', JSON.stringify(jj)); process.exit(1); }
  const cookie = jr.headers.getSetCookie ? jr.headers.getSetCookie().join('; ') : jr.headers.get('set-cookie');
  const token = jj.token;
  console.log(`报名 ok  token=${token.slice(0, 8)}…  cookie=${cookie}`);
  console.log(`Set-Cookie 头: ${JSON.stringify(jr.headers.getSetCookie ? jr.headers.getSetCookie() : jr.headers.get('set-cookie'))}\n`);

  const get = async (rel, baseUrl) => {
    // 播放器是按 manifest 自己的地址去解析相对地址的，这里必须照做
    const url = new URL(rel, baseUrl || (BASE + '/'));
    const r = await fetch(url, { headers: { cookie: (cookie || '').split(';')[0] } });
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('mpegurl') ? await r.text() : null;
    return { url, r, ct, body };
  };

  // 1) 主播放列表
  const manifestRel = `/hls/${P}/index.m3u8?token=${encodeURIComponent(token)}`;
  let cur = manifestRel, curBase = BASE + '/';
  for (let depth = 0; depth < 4; depth++) {
    const { url, r, ct, body } = await get(cur, curBase);
    console.log(`[${depth}] ${r.status}  ${url.pathname}${url.search}   (${ct})`);
    if (r.status !== 200) { console.log('    ❌ 这一步就断了'); console.log('    响应:', (body || '').slice(0, 200)); break; }
    if (!body) { console.log('    (不是播放列表，停在这里 —— 分片拿到了)'); break; }
    if (process.env.SHOW_BODY) console.log('---- 正文 ----\n' + body + '\n--------------');

    const lines = body.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
    const audioUri = (body.match(/URI="([^"]+)"/) || [])[1];
    console.log(`    列表里有 ${lines.length} 个地址:`);
    lines.slice(0, 4).forEach(l => console.log(`      ${l}`));
    if (audioUri) console.log(`    音轨: ${audioUri}`);
    if (!lines.length) { console.log('    (空的)'); break; }
    console.log(`    → 用第一个地址继续: ${lines[0]}`);
    console.log(`      （带 token 吗？${/token=/.test(lines[0]) ? '带 ✅' : '不带 ❌  → 只能靠 cookie'}）`);
    curBase = url.href;      // 下一层按这一层的地址解析
    cur = lines[0];
  }

  // 2) 完全按播放器的方式：不带 query，只带 cookie（分片就是这样发的）
  console.log('\n=== 模拟 hls.js 拿分片：只带 cookie，不带 token ===');
  const r2 = await fetch(new URL(`/hls/${P}/index.m3u8`, BASE), { headers: { cookie: (cookie || '').split(';')[0] } });
  console.log(`主列表无 query: ${r2.status}`);
  if (r2.status === 200) {
    const b = await r2.text();
    const lines = b.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
    console.log('    列表里第一个地址: ' + (lines[0] || '(空)'));
    if (lines[0]) {
      const r3 = await fetch(new URL(lines[0], BASE), { headers: { cookie: (cookie || '').split(';')[0] } });
      console.log(`    取它: ${r3.status}  ${new URL(lines[0], BASE).pathname}`);
    }
  }
})().catch(e => { console.log('异常:', e.message); process.exit(2); });
