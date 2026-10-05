// Plays the part of the browser against the native messaging host.
// usage: node scripts/native-test.mjs [path-to-frameboost-helper.exe]   (default: node server/main.mjs)
// Checks: stdio framing + `ready`, ping/pong, WebSocket origin + token rules, a real frame-generation session, `quit` exit.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.argv[2];
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const cmd = exe || process.execPath;
const args = exe ? [`${ORIGIN}/`] : [path.join(here, '..', 'server', 'main.mjs'), `${ORIGIN}/`];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fails++; };

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = Buffer.alloc(0);
const waiters = [];
child.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const n = buf.readUInt32LE(0);
    const msg = JSON.parse(buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
    waiters.shift()?.(msg);
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[host stderr] ${d}`));
const next = (ms = 15000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for the host')), ms); waiters.push((m) => { clearTimeout(t); res(m); }); });
const send = (obj) => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); child.stdin.write(Buffer.concat([h, b])); };
const exited = new Promise((r) => child.on('exit', (code) => r(code)));

const ready = await next();
check(ready.t === 'ready' && ready.v === 1, `ready message (${JSON.stringify({ ...ready, token: ready.token ? '<' + ready.token.length + ' chars>' : '' })})`);
check(Number.isInteger(ready.port) && ready.port > 1024 && /^[0-9a-f]{32}$/.test(ready.token), 'random port and 32-hex token');
check(Array.isArray(ready.problems), `problems list (${ready.problems.length ? ready.problems.join(' | ') : 'none'})`);

send({ t: 'ping' });
check((await next()).t === 'pong', 'ping -> pong');

const open = (origin) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/live`, origin ? { headers: { Origin: origin } } : {});
  ws.on('open', () => resolve(ws));
  ws.on('unexpected-response', () => resolve(null));
  ws.on('error', () => resolve(null));
});
check((await open('https://evil.example')) === null, 'WebSocket from a web page origin is refused');
check((await open('chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba')) === null, 'WebSocket from another extension is refused');
check((await open(null)) === null, 'WebSocket without Origin is refused');

const bad = await open(ORIGIN);
const badReply = await new Promise((resolve) => { bad.on('message', (d) => resolve(JSON.parse(d.toString()))); bad.send(JSON.stringify({ t: 'hello', v: 1, token: 'f'.repeat(32) })); });
check(badReply.ok === false, 'wrong token is rejected');

const ws = await open(ORIGIN);
check(!!ws, 'WebSocket from the launching extension is accepted');
const got = [];
let ids = null;
ws.on('message', (d, bin) => { if (bin) got.push(d); else { const m = JSON.parse(d.toString()); if (m.t === 'started') ids = m; if (m.t === 'error') console.log('session error:', m.msg); } });
ws.send(JSON.stringify({ t: 'hello', v: 1, token: ready.token }));
await new Promise((r) => setTimeout(r, 400));

if (ready.problems.length === 0) {
  // a short H.264 clip like WebCodecs would send
  const h264 = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-tune', 'zerolatency', '-bf', '0', '-g', '30', '-x264-params', 'aud=1:annexb=1', '-f', 'h264', 'pipe:1'], { maxBuffer: 1 << 28 });
  const starts = [];
  for (let i = 0; i + 4 < h264.length; i++) if (h264[i] === 0 && h264[i + 1] === 0 && h264[i + 2] === 0 && h264[i + 3] === 1 && (h264[i + 4] & 0x1f) === 9) starts.push(i);
  const aus = starts.map((s, i) => h264.subarray(s, starts[i + 1] ?? h264.length));
  ws.send(JSON.stringify({ t: 'start', id: 5, width: 640, height: 360, fps: 30, multiplier: 2, mode: 'medium' }));
  for (let i = 0; i < 40 && !ids; i++) await new Promise((r) => setTimeout(r, 250));
  check(!!ids, 'session started (model loaded)');
  const idb = Buffer.alloc(4); idb.writeUInt32LE(5);
  for (const au of aus) { ws.send(Buffer.concat([idb, au]), { binary: true }); await new Promise((r) => setTimeout(r, 33)); }
  await new Promise((r) => setTimeout(r, 1500));
  const expected = aus.length - 1;
  check(got.length >= expected - 6 && got.length <= expected, `generated frames received: ${got.length} of ${expected}`);
} else {
  console.log('SKIP  session test (the host reports problems on this machine)');
}

send({ t: 'quit' });
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
check(code === 0, `host exits on quit (exit code ${code})`);
console.log(fails ? `\n${fails} check(s) FAILED` : '\nNATIVE HOST TEST PASSED');
process.exit(fails ? 1 : 0);
