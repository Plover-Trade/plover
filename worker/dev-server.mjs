// Local site + API without workerd: the real Worker code on node, D1 on SQLite, the site from ../site. node dev-server.mjs [port]
// Reads SOL_RPC_URL from the environment or .dev.vars.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { sqliteD1 } from './d1-sqlite.mjs';

// the Workers cache, kept in memory
const store = new Map();
globalThis.caches = { default: { match: async (k) => { const e = store.get(k.url); return e && e.until > Date.now() ? new Response(e.body) : undefined; }, put: async (k, r) => { const age = Number((r.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 60); store.set(k.url, { body: await r.text(), until: Date.now() + age * 1000 }); } } };
const { default: worker } = await import('./src/index.js');

const DEV = new URL('./.dev.vars', import.meta.url);
const vars = existsSync(DEV) ? Object.fromEntries(readFileSync(DEV, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) : {};
const db = sqliteD1();
for (const s of readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
const env = { DB: db, FEE_BPS: '50', MAX_LOCK_DAYS: '365', OPEN_DAYS: '7', ...vars, SOL_RPC_URL: process.env.SOL_RPC_URL || vars.SOL_RPC_URL };
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', png: 'image/png', svg: 'image/svg+xml' };
const port = Number(process.argv[2] || 8813);
http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (!path.startsWith('/v1') && path !== '/rpc') {
    const file = new URL('../site' + (path === '/' ? '/index.html' : path), import.meta.url);
    if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[path.split('.').pop()] || 'text/html; charset=utf-8' });
    return res.end(readFileSync(file));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log('PLOVER on http://localhost:' + port));
