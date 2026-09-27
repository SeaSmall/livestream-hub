/* 手机端全流程复现：Edge headless + 移动端模拟（UA / 触摸 / 视口）+ 真实入口链接
   目的：把"手机加载不进直播流"变成可读的证据（网络状态码 + 控制台 + 播放器状态）

   用法：
     node tools/test-mobile.js <入口地址> <白名单里的名字>
   例：
     node tools/test-mobile.js http://frp-add.com:50776 手机测试
     node tools/test-mobile.js http://100.67.153.117:7000 手机测试

   只杀自己拉起来的那个浏览器进程；不会碰你正在用的浏览器窗口。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const ENTRY = (process.argv[2] || 'http://127.0.0.1:7000').replace(/\/+$/, '');
const NAME = process.argv[3] || '';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 9344;
const USER_DIR = path.join(os.tmpdir(), 'ls-edge-mobile-' + Date.now());
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, stepMs) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(stepMs || 250);
  }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.events = []; }
  static async attach(url) {
    const ws = new WebSocket(url, { maxPayload: 128 * 1024 * 1024 });
    const c = new Cdp(ws);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && c.waiters.has(m.id)) {
        const w = c.waiters.get(m.id); c.waiters.delete(m.id);
        m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
        return;
      }
      if (m.method) c.events.push(m);
    });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); rej(new Error('cdp timeout: ' + method)); } }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return r.result && r.result.value;
  }
}

(async () => {
  console.log(`入口: ${ENTRY}   名字: ${NAME || '(从 localStorage 取)'}`);
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${USER_DIR}`, `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  try {
    const first = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const j = await r.json();
      return j.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    }, 20000, 400);
    if (!first) throw new Error('连不上 Edge 调试端口');
    cdp = await Cdp.attach(first.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });

    // SLOW_ME=6000：把 /api/me 人为拖住 6 秒，复现"半开连接一直挂着"的情形。
    // 页面必须在它挂住的时候照样开始拉流（早先写成 await 就会卡死在这里）。
    const slowMe = Number(process.env.SLOW_ME || 0);
    if (slowMe > 0) {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/me*' }] });
      cdp.ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        if (m.method !== 'Fetch.requestPaused') return;
        const reqId = m.params.requestId;
        console.log(`    （拖住 /api/me ${slowMe}ms 再放行）`);
        setTimeout(() => { cdp.send('Fetch.continueRequest', { requestId: reqId }).catch(() => {}); }, slowMe);
      });
      console.log(`[0] 已挂上慢速钩子：/api/me 延迟 ${slowMe}ms`);
    }

    await cdp.send('Page.navigate', { url: ENTRY + '/' });
    await sleep(6000);   // 入口页要做局域网探测，手机上慢

    const where = await cdp.eval('location.href');
    console.log(`\n[1] 落在: ${where}`);
    const hasInput = await cdp.eval('!!document.getElementById("nameInput")');
    console.log(`    有名字输入框: ${hasInput}`);
    if (!hasInput) {
      const chat = await cdp.eval('!!document.getElementById("chatList")');
      console.log(`    （可能已经在观看页: chatList=${chat}）`);
    }
    if (hasInput && NAME) {
      await cdp.eval(`(function(){
        document.getElementById('nameInput').value=${JSON.stringify(NAME)};
        document.getElementById('joinBtn').click(); return 1; })()`);
      const ok = await waitFor(async () => (await cdp.eval('location.pathname')) === '/watch', 10000, 400);
      console.log(`[2] 进入 /watch: ${ok}   (当前 ${await cdp.eval('location.pathname')})`);
      if (!ok) {
        console.log('    页面提示: ' + JSON.stringify(await cdp.eval('(document.getElementById("msgBox")||{}).textContent||""')));
      }
    }

    console.log('\n[3] 等 25 秒，看播放器自己走到哪一步…');
    await sleep(25000);

    const st = await cdp.eval(`(function(){
      var v=document.getElementById('v')||{};
      return {
        path: location.pathname,
        cookie: document.cookie,
        overlay: (document.getElementById('ovText')||{}).textContent||'',
        overlayVisible: (document.getElementById('overlay')||{}).className||'',
        status: (document.getElementById('stText')||{}).textContent||'',
        route: (document.getElementById('stRoute')||{}).textContent||'',
        lag: (document.getElementById('stLag')||{}).textContent||'',
        chat: (document.getElementById('onlineTip')||{}).textContent||'',
        video: { readyState: v.readyState, currentTime: v.currentTime, paused: v.paused,
                 src: (v.getAttribute && v.getAttribute('src'))||'', hasStream: !!v.srcObject,
                 err: v.error ? (v.error.code + '/' + v.error.message) : null }
      };
    })()`);
    console.log('    ' + JSON.stringify(st, null, 2).replace(/\n/g, '\n    '));

    // 网络：媒体与接口的状态码
    const reqs = cdp.events.filter(e => e.method === 'Network.responseReceived').map(e => e.params.response);
    const interesting = reqs.filter(r => /\/(hls|whep|api)\//.test(r.url));
    console.log('\n[4] 关键请求（按发生顺序，最多 30 条）:');
    const seen = new Set();
    let n = 0;
    for (const r of interesting) {
      if (n++ > 30) break;
      const u = r.url.replace(ENTRY, '').slice(0, 110);
      console.log(`    ${String(r.status).padEnd(4)} ${u}`);
    }
    if (!interesting.length) console.log('    （一个都没有 —— 说明页面根本没走到拉流那一步）');

    const failed = cdp.events.filter(e => e.method === 'Network.loadingFailed').map(e => e.params);
    if (failed.length) {
      console.log('\n[5] 失败的网络请求:');
      failed.slice(0, 12).forEach(f => console.log(`    ${f.errorText}  ${(f.type || '')}`));
    }

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown')
      .map(e => (e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text);
    const logErrs = cdp.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map(e => e.params.entry.text);
    console.log('\n[6] JS 异常: ' + (errs.length ? '\n    ' + errs.join('\n    ') : '无'));
    console.log('[6] 控制台 error: ' + (logErrs.length ? '\n    ' + logErrs.slice(0, 10).join('\n    ') : '无'));
  } catch (e) {
    console.log('测试脚本异常: ' + e.message);
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(600);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(0);
})();
