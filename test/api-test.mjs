// The whole life of a block through the real Worker code, on SQLite, with the chain faked: list, ask, sign, land, plus the refusals.
// Offline. Run: node --disable-warning=ExperimentalWarning api-test.mjs
import { createRequire } from 'node:module';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { sqliteD1 } from '../worker/d1-sqlite.mjs';
const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const R = require('../site/plover.js')(web3);
const { Keypair, PublicKey, TransactionMessage, VersionedTransaction } = web3;

const store = new Map();
globalThis.caches = { default: { match: async (k) => (store.has(k.url) ? new Response(store.get(k.url)) : undefined), put: async (k, r) => store.set(k.url, await r.text()) } };
const { default: worker } = await import('../worker/src/index.js');

let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const b64 = (b) => Buffer.from(b).toString('base64');
const signText = (kp, text) => b64(edSign(null, Buffer.from(text), createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })));

const seller = Keypair.generate(), buyer = Keypair.generate(), other = Keypair.generate(), nonce = Keypair.generate().publicKey;
const MINT = 'EVNuBvvk5RgqKVStMEV9ha9nnZ3ZPeUVS1byL4Udpump';
const nonceValue = Keypair.generate().publicKey;
const nonceData = new Uint8Array(80); new DataView(nonceData.buffer).setUint32(4, 1, true); nonceData.set(seller.publicKey.toBytes(), 8); nonceData.set(nonceValue.toBytes(), 40);
let landedSig = null, sellerSig = null;

// the chain, faked: a Token-2022 mint, the seller's balance, the nonce, a dry run, the landed transaction
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('dexscreener')) return new Response(JSON.stringify([{ baseToken: { address: MINT }, quoteToken: { address: 'So11111111111111111111111111111111111111112' }, priceNative: '0.00000003', liquidity: { usd: 20000 }, dexId: 'pumpswap', url: 'x' }]));
  if (String(url) !== 'http://rpc.test') return realFetch(url, init);
  const { method, params } = JSON.parse(init.body);
  const out = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  if (method === 'getAccountInfo' && params[0] === MINT) return out({ value: { owner: R.TOKEN_2022.toBase58(), data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000000', extensions: [{ extension: 'tokenMetadata', state: { name: 'Homer', symbol: 'HOMER' } }] } } } } });
  if (method === 'getAccountInfo' && params[0] === nonce.toBase58()) return out({ value: { owner: '11111111111111111111111111111111', lamports: R.NONCE_RENT, data: [b64(nonceData), 'base64'] } });
  if (method === 'getAsset') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'no DAS' } }));
  if (method === 'getTokenAccountsByOwner') return out({ value: params[0] === seller.publicKey.toBase58() ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: '50000000000000' } } } } } }] : [] });
  if (method === 'simulateTransaction') return out({ value: { err: null, logs: [] } });
  if (method === 'getTransaction') return out(params[0] === landedSig ? { meta: { err: null }, transaction: { signatures: [landedSig, sellerSig] } } : null);
  throw new Error('unexpected RPC ' + method);
};

const env = { DB: sqliteD1(), SOL_RPC_URL: 'http://rpc.test', FEE_BPS: '50', FEE_WALLET: 'HELnQfJ9mtWX4eoyxQaQF1q53yBAjjxAhGLNYFJdMMxi', MAX_LOCK_DAYS: '365', OPEN_DAYS: '7' };
const hit = async (path, body) => { const r = await worker.fetch(new Request('http://x' + path, body ? { method: 'POST', body: JSON.stringify(body) } : {}), env); return { status: r.status, ...(await r.json()) }; };
const now = Math.floor(Date.now() / 1000);
const listLines = (f) => `PLOVER · list a block\nmint: ${f.mint}\namount: ${f.amount}\nprice: ${f.lamports} lamports\nlock until: ${f.lock_until || 0}\nbuyer: ${f.buyer || 'any'}\ntime: ${f.time}`;

for (const lock of [0, now + 30 * 86400]) {
  const f = { mint: MINT, amount: '30000000000000', lamports: '850000000', lock_until: lock, buyer: null, time: now };
  const name = lock ? 'locked' : 'plain';
  let r = await hit('/v1/blocks', { ...f, seller: other.publicKey.toBase58(), signature: signText(seller, listLines(f)) });
  ok(`${name}: listing signed by another wallet refused`, r.status === 401, r.error);
  r = await hit('/v1/blocks', { ...f, amount: '60000000000000', seller: seller.publicKey.toBase58(), signature: signText(seller, listLines({ ...f, amount: '60000000000000' })) });
  ok(`${name}: listing more than held refused`, r.status === 400, r.error);
  r = await hit('/v1/blocks', { ...f, seller: seller.publicKey.toBase58(), note: 'team bag <b>', signature: signText(seller, listLines(f)) });
  ok(`${name}: listing accepted`, r.status === 201 && /^b[a-z0-9]{8}$/.test(r.id), r.id || r.error);
  const id = r.id;
  r = await hit(`/v1/block/${id}/request`, { buyer: buyer.publicKey.toBase58(), time: now, signature: signText(buyer, `PLOVER · ask for block ${id}\ntime: ${now}`) });
  ok(`${name}: buyer asks`, r.ok === true, r.error);
  r = await hit(`/v1/block/${id}/request`, { buyer: seller.publicKey.toBase58(), time: now, signature: signText(seller, `PLOVER · ask for block ${id}\ntime: ${now}`) });
  ok(`${name}: seller cannot ask for own block`, r.status === 400, r.error);
  const fee = await hit(`/v1/block/${id}/fee?buyer=${buyer.publicKey.toBase58()}`);
  ok(`${name}: fee is 0.5% of the price`, fee.fee === '4250000', fee.fee);

  // the seller's page builds and signs it, as the site does
  const build = (to) => {
    const tag = Keypair.generate(), base = Keypair.generate();
    const { ixs } = R.block({ seller: seller.publicKey, buyer: to, mint: MINT, program: R.TOKEN_2022, decimals: 6, amount: BigInt(f.amount), lamports: BigInt(f.lamports), fee: BigInt(fee.fee), feeWallet: fee.fee_wallet, nonce, id, lockUntil: lock, signedAt: now, base: base.publicKey, tag: tag.publicKey });
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: to, recentBlockhash: nonceValue.toBase58(), instructions: ixs }).compileToV0Message());
    tx.sign([seller, lock ? base : tag]);
    return tx;
  };
  r = await hit(`/v1/block/${id}/sign`, { buyer: other.publicKey.toBase58(), nonce: nonce.toBase58(), tx: b64(build(other.publicKey).serialize()) });
  ok(`${name}: signing for a wallet that did not ask refused`, r.status === 400, r.error);
  const tx = build(buyer.publicKey);
  r = await hit(`/v1/block/${id}/sign`, { buyer: buyer.publicKey.toBase58(), nonce: nonce.toBase58(), tx: b64(tx.serialize()) });
  ok(`${name}: seller signs for the buyer`, r.ok === true && r.simulation === 'ok', r.error || r.simulation);
  const one = await hit(`/v1/block/${id}`);
  ok(`${name}: block page shows signed, with the transaction`, one.block.status === 'signed' && one.block.tx && one.block.note === 'team bag b', `${one.block.status}, note "${one.block.note}"`);
  const board = await hit('/v1/blocks');
  ok(`${name}: on the board`, board.blocks.some((b) => b.id === id && !b.tx), `${board.blocks.length} on the board`);

  // the buyer signs and it lands
  sellerSig = require('bs58').default.encode(tx.signatures[tx.message.staticAccountKeys.findIndex((k) => k.equals(seller.publicKey))]);
  tx.sign([buyer]);
  landedSig = require('bs58').default.encode(tx.signatures[0]);
  r = await hit(`/v1/block/${id}/done`, { signature: Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58().slice(0, 44) });
  ok(`${name}: a random signature is not the block`, r.status === 409 || r.status === 400, r.error);
  r = await hit(`/v1/block/${id}/done`, { signature: landedSig });
  ok(`${name}: landed`, r.ok === true, r.error);
}
const tape = await hit('/v1/tape');
ok('tape has both, totals add up', tape.totals.blocks === 2 && tape.totals.lamports === 1700000000, JSON.stringify(tape.totals));
const mine = await hit(`/v1/wallet/${buyer.publicKey.toBase58()}`);
ok('buyer sees both under buying', mine.buying.length === 2, `${mine.buying.length}`);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
