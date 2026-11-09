// PLOVER worker: serves the site, keeps the board of blocks, checks every signed block, forwards a short list of RPC calls.
//   GET  /v1/config              fee, token and limits for the page
//   GET  /v1/token/:mint         what the page needs to price a block: decimals, supply, price in SOL
//   GET  /v1/blocks              the board: blocks waiting for a buyer or for the buyer's signature
//   GET  /v1/tape                blocks that landed
//   GET  /v1/block/:id           one block with its requests and, once signed, the transaction
//   GET  /v1/wallet/:addr        blocks a wallet sells, blocks it asked for, blocks signed for it
//   POST /v1/blocks              a seller lists a block (signed message)
//   POST /v1/block/:id/request   a buyer asks for an open block (signed message)
//   POST /v1/block/:id/sign      the seller's signed transaction for one buyer
//   POST /v1/block/:id/done      the buyer's signature after the block landed
//   POST /v1/block/:id/cancel    the seller takes an open block down, or reports a closed nonce
//   POST /rpc                    read and send calls for the page (allowlist)
// PLOVER never holds tokens, SOL or keys: the seller's signature waits on a durable nonce until the buyer adds theirs.

import { b58encode, isPubkey, fromB64, verifySig, checkBlock, TOKEN, TOKEN_2022 } from './tx.js';

const SOL = 'So11111111111111111111111111111111111111112';
const ALLOWED = new Set(['getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getLatestBlockhash', 'getTokenAccountsByOwner', 'sendTransaction', 'simulateTransaction', 'getSignatureStatuses']);
const MAX_BODY = 16 * 1024, MSG_AGE = 600, DAY = 86400;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const fail = (status, error) => Object.assign(new Error(error), { status });
const now = () => Math.floor(Date.now() / 1000);

// ---------- chain ----------
async function call(env, method, params) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(env.SOL_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if ((r.status === 429 || r.status >= 500) && attempt < 2) { await new Promise((res) => setTimeout(res, 600 * 2 ** attempt)); continue; }
    const j = await r.json().catch(() => null);
    if (!j || j.error) throw fail(503, j?.error?.message || 'Solana RPC is busy, try again in a moment');
    return j.result;
  }
}

// mint facts and a SOL price; blocks are refused for mints whose transfers can be taxed, hooked or frozen
async function token(env, mint) {
  const cache = caches.default, key = new Request(`https://plover.internal/token/${mint}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const acc = (await call(env, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]))?.value;
  if (!acc || acc.data?.parsed?.type !== 'mint' || ![TOKEN, TOKEN_2022].includes(acc.owner)) throw fail(404, 'that is not a token mint');
  const info = acc.data.parsed.info;
  const ext = (info.extensions || []).map((x) => x.extension);
  const blocked = ['transferFeeConfig', 'transferHook', 'nonTransferable', 'permanentDelegate', 'defaultAccountState', 'confidentialTransferMint'].filter((x) => ext.includes(x));
  const meta = (info.extensions || []).find((x) => x.extension === 'tokenMetadata')?.state;
  const out = { mint, program: acc.owner, decimals: info.decimals, supply: info.supply, freeze: !!info.freezeAuthority, name: meta?.name || null, symbol: meta?.symbol || null, image: null, blocked, price_sol: null, liquidity_usd: null, pair: null };
  try {
    const a = await call(env, 'getAsset', { id: mint });
    out.name = a?.content?.metadata?.name || out.name;
    out.symbol = a?.content?.metadata?.symbol || out.symbol;
    out.image = a?.content?.links?.image || null;
  } catch {}
  out.symbol = out.symbol ? out.symbol.replace(/^\$+/, '') : null;
  // the deepest SOL pair on DexScreener is the pool the block stays away from
  try {
    const pairs = await (await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`)).json();
    const best = (Array.isArray(pairs) ? pairs : []).filter((p) => p.quoteToken?.address === SOL && p.baseToken?.address === mint).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
    if (best) { out.price_sol = Number(best.priceNative); out.liquidity_usd = best.liquidity?.usd ?? null; out.pair = { dex: best.dexId, url: best.url }; }
  } catch {}
  await cache.put(key, new Response(JSON.stringify(out), { headers: { 'cache-control': 'max-age=60' } }));
  return out;
}

async function balanceOf(env, wallet, mint) {
  const got = await call(env, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]);
  return got.value.reduce((t, a) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

// the fee, in lamports, for one block: none when either side holds enough of the token
async function feeFor(env, b) {
  const bps = BigInt(env.FEE_BPS || 0);
  if (!env.FEE_WALLET || !bps) return 0n;
  if (env.TOKEN_ADDRESS && env.HOLDER_MIN) {
    const min = BigInt(env.HOLDER_MIN);
    for (const w of [b.seller, b.buyer].filter(Boolean)) {
      try { if ((await balanceOf(env, w, env.TOKEN_ADDRESS)) >= min) return 0n; } catch {}
    }
  }
  return (BigInt(b.lamports) * bps) / 10000n;
}

// ---------- messages ----------
// The page asks the wallet to sign these exact lines; the time keeps an old signature from being replayed.
const lines = {
  list: (f) => `PLOVER · list a block\nmint: ${f.mint}\namount: ${f.amount}\nprice: ${f.lamports} lamports\nlock until: ${f.lock_until || 0}\nbuyer: ${f.buyer || 'any'}\ntime: ${f.time}`,
  request: (f) => `PLOVER · ask for block ${f.id}\ntime: ${f.time}`,
  cancel: (f) => `PLOVER · take down block ${f.id}\ntime: ${f.time}`,
};
async function signed(kind, f, wallet, signature) {
  if (!isPubkey(wallet)) throw fail(400, 'that wallet address looks wrong');
  if (!Number.isInteger(f.time) || Math.abs(now() - f.time) > MSG_AGE) throw fail(400, 'the signed message is too old, sign again');
  let sig; try { sig = fromB64(signature); } catch { throw fail(400, 'bad signature'); }
  if (!(await verifySig(wallet, sig, new TextEncoder().encode(lines[kind](f))))) throw fail(401, 'the signature does not match the wallet');
}

// ---------- blocks ----------
const PUBLIC = 'id, seller, mint, program, decimals, symbol, name, image, supply, amount, lamports, lock_until, buyer, note, status, created, expires, signed_at, fee, done_sig, done_at, market_lamports';
const row = (env, id) => env.DB.prepare(`SELECT * FROM blocks WHERE id = ?`).bind(id).first();
const newId = () => 'b' + [...crypto.getRandomValues(new Uint8Array(8))].map((x) => (x % 36).toString(36)).join('');

async function list(env, body) {
  const f = { mint: body.mint, amount: String(body.amount ?? ''), lamports: String(body.lamports ?? ''), lock_until: Number(body.lock_until || 0), buyer: body.buyer || null, time: Number(body.time) };
  if (!isPubkey(f.mint)) throw fail(400, 'that token address looks wrong');
  if (!/^[1-9]\d{0,19}$/.test(f.amount) || !/^[1-9]\d{0,17}$/.test(f.lamports)) throw fail(400, 'amount and price must be whole numbers above zero');
  if (f.buyer && (!isPubkey(f.buyer) || f.buyer === body.seller)) throw fail(400, 'the buyer must be another wallet');
  const days = Number(env.MAX_LOCK_DAYS || 365);
  if (f.lock_until && (f.lock_until < now() + DAY || f.lock_until > now() + days * DAY)) throw fail(400, `a lock runs from 1 to ${days} days`);
  await signed('list', f, body.seller, body.signature);
  const t = await token(env, f.mint);
  if (t.blocked.length) throw fail(400, `this token's transfers can be taxed or stopped (${t.blocked.join(', ')}), so blocks are off`);
  const have = await balanceOf(env, body.seller, f.mint);
  if (have < BigInt(f.amount)) throw fail(400, 'the wallet does not hold that many tokens');
  const open = await env.DB.prepare(`SELECT COUNT(*) AS n FROM blocks WHERE seller = ? AND status IN ('open', 'signed')`).bind(body.seller).first();
  if (open.n >= 10) throw fail(429, 'ten blocks at a time per wallet');
  const note = String(body.note || '').slice(0, 140).replace(/[<>]/g, '');
  const market = t.price_sol ? String(BigInt(Math.round((Number(f.amount) / 10 ** t.decimals) * t.price_sol * 1e9))) : null;
  const id = newId();
  await env.DB.prepare(`INSERT INTO blocks (id, seller, mint, program, decimals, symbol, name, image, supply, amount, lamports, lock_until, buyer, note, status, created, expires, market_lamports)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .bind(id, body.seller, f.mint, t.program, t.decimals, t.symbol, t.name, t.image, t.supply, f.amount, f.lamports, f.lock_until, f.buyer, note, now(), now() + Number(env.OPEN_DAYS || 7) * DAY, market).run();
  if (f.buyer) await env.DB.prepare('INSERT OR IGNORE INTO requests (block, buyer, created) VALUES (?, ?, ?)').bind(id, f.buyer, now()).run();
  return { id };
}

async function ask(env, id, body) {
  const b = await row(env, id);
  if (!b || b.status !== 'open') throw fail(404, 'that block is not open');
  if (b.buyer && b.buyer !== body.buyer) throw fail(403, 'this block is for one named buyer');
  if (body.buyer === b.seller) throw fail(400, 'the seller cannot buy their own block');
  await signed('request', { id, time: Number(body.time) }, body.buyer, body.signature);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE block = ?').bind(id).first();
  if (n.n >= 50) throw fail(429, 'this block has enough requests');
  await env.DB.prepare('INSERT OR IGNORE INTO requests (block, buyer, note, created) VALUES (?, ?, ?, ?)').bind(id, body.buyer, String(body.note || '').slice(0, 140).replace(/[<>]/g, ''), now()).run();
  return { ok: true };
}

// the seller signed for one buyer: check every instruction, the nonce and the seller's signature before the buyer ever sees it
async function sign(env, id, body) {
  const b = await row(env, id);
  if (!b || b.status !== 'open') throw fail(404, 'that block is not open');
  if (!isPubkey(body.buyer) || !isPubkey(body.nonce)) throw fail(400, 'buyer and nonce are needed');
  const asked = await env.DB.prepare('SELECT 1 FROM requests WHERE block = ? AND buyer = ?').bind(id, body.buyer).first();
  if (!asked) throw fail(400, 'that wallet did not ask for this block');
  const acc = (await call(env, 'getAccountInfo', [body.nonce, { encoding: 'base64' }]))?.value;
  const raw = acc && fromB64(acc.data[0]);
  if (!acc || acc.owner !== '11111111111111111111111111111111' || raw.length !== 80) throw fail(400, 'the nonce account is not there yet, try again in a few seconds');
  if (b58encode(raw.subarray(8, 40)) !== b.seller) throw fail(400, 'the nonce belongs to another wallet');
  const terms = { ...b, buyer: body.buyer, nonce: body.nonce, nonce_value: b58encode(raw.subarray(40, 72)) };
  let tx; try { tx = fromB64(body.tx); } catch { throw fail(400, 'bad transaction'); }
  if (tx.length > 1232) throw fail(400, 'transaction too large');
  const fee = await feeFor(env, terms);
  const got = await checkBlock(tx, terms, { fee, feeWallet: env.FEE_WALLET || null });
  // a dry run: a seller who no longer has the tokens is told now, not the buyer later
  const sim = await call(env, 'simulateTransaction', [body.tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false }]).catch((e) => ({ value: { err: e.message } }));
  const err = sim?.value?.err;
  if (err && /insufficient funds/.test(JSON.stringify(sim.value.logs || []))) throw fail(400, 'the seller no longer holds the tokens for this block');
  await env.DB.prepare(`UPDATE blocks SET status = 'signed', buyer = ?, nonce = ?, nonce_value = ?, tx = ?, seller_sig = ?, fee = ?, signed_at = ? WHERE id = ? AND status = 'open'`)
    .bind(body.buyer, body.nonce, terms.nonce_value, body.tx, got.seller_sig, got.fee, now(), id).run();
  return { ok: true, simulation: err ? JSON.stringify(err) : 'ok' };
}

// the block landed when a confirmed transaction carries the seller's signature
async function landed(env, b, signature) {
  const t = await call(env, 'getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  return !!t && !t.meta?.err && t.transaction.signatures.includes(b.seller_sig);
}

async function done(env, id, body) {
  const b = await row(env, id);
  if (!b || b.status !== 'signed') throw fail(404, 'that block is not waiting');
  if (typeof body.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(body.signature)) throw fail(400, 'bad signature');
  if (!(await landed(env, b, body.signature))) throw fail(409, 'that transaction is not the block, or has not landed yet');
  await env.DB.prepare(`UPDATE blocks SET status = 'done', done_sig = ?, done_at = ?, tx = NULL WHERE id = ?`).bind(body.signature, now(), id).run();
  return { ok: true };
}

// open blocks come down on a signed message; a signed block only once its nonce is gone, because until then it can still land
async function cancel(env, id, body) {
  const b = await row(env, id);
  if (!b || !['open', 'signed'].includes(b.status)) throw fail(404, 'that block is not live');
  if (b.status === 'open') {
    await signed('cancel', { id, time: Number(body.time) }, b.seller, body.signature);
    await env.DB.prepare(`UPDATE blocks SET status = 'cancelled' WHERE id = ?`).bind(id).run();
    return { status: 'cancelled' };
  }
  const status = await settle(env, b);
  if (status === 'signed') throw fail(409, 'the nonce is still open, so the buyer can still take the block: close it first');
  return { status };
}

// a signed block whose nonce moved either landed or was cancelled: look at the nonce's last transactions to tell which
async function settle(env, b) {
  const acc = (await call(env, 'getAccountInfo', [b.nonce, { encoding: 'base64' }]))?.value;
  if (acc) {
      if (b58encode(fromB64(acc.data[0]).subarray(40, 72)) === b.nonce_value) return 'signed';
  }
  const sigs = await call(env, 'getSignaturesForAddress', [b.nonce, { limit: 5 }]);
  for (const s of sigs) {
    if (!s.err && (await landed(env, b, s.signature))) {
      await env.DB.prepare(`UPDATE blocks SET status = 'done', done_sig = ?, done_at = ?, tx = NULL WHERE id = ?`).bind(s.signature, s.blockTime || now(), b.id).run();
      return 'done';
    }
  }
  await env.DB.prepare(`UPDATE blocks SET status = 'cancelled', tx = NULL WHERE id = ?`).bind(b.id).run();
  return 'cancelled';
}

async function board(env) {
  const { results } = await env.DB.prepare(`SELECT ${PUBLIC}, (SELECT COUNT(*) FROM requests r WHERE r.block = blocks.id) AS asks FROM blocks WHERE status IN ('open', 'signed') AND (status = 'signed' OR expires > ?) ORDER BY created DESC LIMIT 100`).bind(now()).all();
  return { blocks: results, now: now() };
}

async function tape(env) {
  const { results } = await env.DB.prepare(`SELECT ${PUBLIC} FROM blocks WHERE status = 'done' ORDER BY done_at DESC LIMIT 50`).all();
  const totals = await env.DB.prepare(`SELECT COUNT(*) AS blocks, COALESCE(SUM(CAST(lamports AS INTEGER)), 0) AS lamports, COUNT(DISTINCT mint) AS tokens FROM blocks WHERE status = 'done'`).first();
  return { tape: results, totals };
}

async function one(env, id) {
  const b = await env.DB.prepare(`SELECT ${PUBLIC}, nonce, nonce_value, tx FROM blocks WHERE id = ?`).bind(id).first();
  if (!b) throw fail(404, 'no such block');
  const { results } = await env.DB.prepare('SELECT buyer, note, created FROM requests WHERE block = ? ORDER BY created').bind(id).all();
  return { block: b, requests: results, now: now() };
}

async function wallet(env, addr) {
  const sold = await env.DB.prepare(`SELECT ${PUBLIC}, (SELECT COUNT(*) FROM requests r WHERE r.block = blocks.id) AS asks FROM blocks WHERE seller = ? ORDER BY created DESC LIMIT 50`).bind(addr).all();
  const bought = await env.DB.prepare(`SELECT ${PUBLIC} FROM blocks WHERE id IN (SELECT block FROM requests WHERE buyer = ?) OR buyer = ? ORDER BY created DESC LIMIT 50`).bind(addr, addr).all();
  return { selling: sold.results, buying: bought.results, now: now() };
}

async function rpc(request, env) {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too large' } }, 413);
  let c; try { c = JSON.parse(text); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad JSON' } }, 400); }
  if (Array.isArray(c) || !ALLOWED.has(c?.method)) return json({ jsonrpc: '2.0', id: c?.id ?? null, error: { code: -32000, message: 'Method not allowed' } }, 403);
  const up = await fetch(env.SOL_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  return new Response(up.body, { status: up.status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url), p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (!env.SOL_RPC_URL && (p === '/rpc' || p.startsWith('/v1/'))) throw fail(503, 'RPC is not set');
      if (p === '/rpc' && request.method === 'POST') return rpc(request, env);
      const body = async () => { const t = await request.text(); if (t.length > MAX_BODY) throw fail(413, 'too big'); try { return JSON.parse(t); } catch { throw fail(400, 'bad JSON'); } };
      if (request.method === 'GET') {
        if (p === '/v1') return json({ name: 'PLOVER API', endpoints: ['/v1/config', '/v1/token/:mint', '/v1/blocks', '/v1/tape', '/v1/block/:id', '/v1/wallet/:addr'] });
        if (p === '/v1/config') return json({ fee_bps: env.FEE_WALLET ? Number(env.FEE_BPS || 0) : 0, fee_wallet: env.FEE_WALLET || null, token: env.TOKEN_ADDRESS || null, holder_min: env.HOLDER_MIN || null, max_lock_days: Number(env.MAX_LOCK_DAYS || 365), open_days: Number(env.OPEN_DAYS || 7) });
        if (p === '/v1/blocks') return json(await board(env));
        if (p === '/v1/tape') return json(await tape(env), 200, { 'cache-control': 'max-age=20' });
        let m = p.match(/^\/v1\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
        if (m) return json(await token(env, m[1]));
        m = p.match(/^\/v1\/block\/(b[a-z0-9]{8})$/);
        if (m) return json(await one(env, m[1]));
        m = p.match(/^\/v1\/block\/(b[a-z0-9]{8})\/fee$/);
        if (m) { const b = await row(env, m[1]); if (!b) throw fail(404, 'no such block'); return json({ fee: String(await feeFor(env, { ...b, buyer: url.searchParams.get('buyer') })), fee_wallet: env.FEE_WALLET || null }); }
        m = p.match(/^\/v1\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
        if (m) return json(await wallet(env, m[1]));
      }
      if (request.method === 'POST') {
        if (p === '/v1/blocks') return json(await list(env, await body()), 201);
        const m = p.match(/^\/v1\/block\/(b[a-z0-9]{8})\/(request|sign|done|cancel)$/);
        if (m) return json(await ({ request: ask, sign, done, cancel })[m[2]](env, m[1], await body()));
      }
      throw fail(404, 'not found');
    } catch (e) {
      if (!e.status) console.error(e);
      return json({ error: e.status ? e.message : 'internal error' }, e.status || 500);
    }
  },

  // signed blocks whose nonce moved are settled as landed or cancelled; open blocks past their date expire
  async scheduled(event, env) {
    await env.DB.prepare(`UPDATE blocks SET status = 'expired' WHERE status = 'open' AND expires < ?`).bind(now()).run();
    const { results } = await env.DB.prepare(`SELECT * FROM blocks WHERE status = 'signed' ORDER BY signed_at LIMIT 25`).all();
    for (const b of results) { try { await settle(env, b); } catch (e) { console.error('settle', b.id, e.message); } }
  },
};
