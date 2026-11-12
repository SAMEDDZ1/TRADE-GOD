/* dev/trading-preview/server.js — run the TRADING DESK on its own, with NO npm packages.

     node dev/trading-preview/server.js [--port=8788] [--dir=<state dir>]   then open http://127.0.0.1:8788/

   It mounts the real /api/trading/* routes (sidecar/trading/routes.js) and the real window (frontend/app/windows/
   trading.js) inside a minimal page, so the trading engine and its screens can be tried — and screenshotted in CI —
   without booting the whole station. State goes to a temp folder unless --dir is given. Loopback only. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { makeTradingRoutes } = require('../../sidecar/trading/routes.js');
const arg = (k, d) => { const a = process.argv.find(x => x.indexOf('--' + k + '=') === 0); return a ? a.slice(k.length + 3) : d; };
const PORT = Number(arg('port', 8788));
const DIR = arg('dir', fs.mkdtempSync(path.join(os.tmpdir(), 'tradegod-preview-')));
const ROOT = path.join(__dirname, '..', '..');
const respondJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req, max) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > max) { reject(Object.assign(new Error('body too large'), { tooLarge: true })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
});
const desk = makeTradingRoutes({ fs, path, dir: DIR, readBody, respondJson, fetch: (...a) => fetch(...a), log: l => console.log(l) });
const FILES = {
  '/app/tradingchart.js': 'frontend/app/tradingchart.js', '/app/windows/trading.js': 'frontend/app/windows/trading.js',
  '/css/trading.css': 'frontend/css/trading.css', '/shared/specialties.js': 'shared/specialties.js', '/icon.png': 'src-tauri/icons/128x128.png'
};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.html': 'text/html' };
const server = http.createServer(async (req, res) => {
  const p = String(req.url).split('?')[0];
  const route = desk.routes.find(r => r.m === req.method && (r.exact === p || r.qsplit === p));
  if (route) return route.h(req, res);
  if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
  if (FILES[p]) { res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); return res.end(fs.readFileSync(path.join(ROOT, FILES[p]))); }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => console.log('TRADE GOD trading desk preview: http://127.0.0.1:' + PORT + '/  (state: ' + DIR + ')'));
