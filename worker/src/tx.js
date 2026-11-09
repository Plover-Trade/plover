// Reading and checking a signed block without web3.js: base58, the transaction wire format, Ed25519, and the rules a block must follow.
// The rules matter for the buyer: they sign whatever the seller built, so anything that could touch the buyer's wallet beyond
// the price, the fee and the token account rent is refused here and again in the page.

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = A.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
export const isPubkey = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && (() => { try { return b58decode(s).length === 32; } catch { return false; } })();
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toB64 = (b) => btoa(String.fromCharCode(...b));

export async function verifySig(pubkey, signature, message) {
  try {
    const key = await crypto.subtle.importKey('raw', typeof pubkey === 'string' ? b58decode(pubkey) : pubkey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, signature, message);
  } catch { return false; }
}

// compact-u16 length, then the parts of a legacy or v0 transaction; address lookup tables are refused
export function parseTx(bytes) {
  let at = 0;
  const len = () => { let v = 0, s = 0; for (;;) { const b = bytes[at++]; v |= (b & 127) << s; if (!(b & 128)) return v; s += 7; } };
  const take = (n) => { if (at + n > bytes.length) throw new Error('short transaction'); const out = bytes.subarray(at, at + n); at += n; return out; };
  const sigs = []; for (let i = len(); i > 0; i--) sigs.push(take(64));
  const start = at;
  const versioned = bytes[at] & 128;
  if (versioned) { if ((bytes[at] & 127) !== 0) throw new Error('only v0 transactions'); at++; }
  const [required, roSigned, roUnsigned] = take(3);
  const keys = []; for (let i = len(); i > 0; i--) keys.push(b58encode(take(32)));
  const blockhash = b58encode(take(32));
  const ixs = [];
  for (let i = len(); i > 0; i--) {
    const program = take(1)[0];
    const accounts = []; for (let k = len(); k > 0; k--) accounts.push(take(1)[0]);
    const data = take(len());
    ixs.push({ program: keys[program], accounts: accounts.map((a) => keys[a]), data });
  }
  if (versioned && len() !== 0) throw new Error('address lookup tables are not allowed');
  if (at !== bytes.length) throw new Error('trailing bytes');
  const writable = (i) => (i < required ? i < required - roSigned : i < keys.length - roUnsigned);
  return { sigs, message: bytes.subarray(start, at), required, keys, blockhash, ixs, writable };
}

const SYSTEM = '11111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const LOCKER = 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const RECENT = 'SysvarRecentB1ockHashes11111111111111111111';
const CREATE = [181, 155, 104, 183, 182, 128, 35, 47];
const MAX_UNITS = 400000, MAX_PRICE = 1000000; // the buyer pays at most 0.0004 SOL in priority fees

const view = (d) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u32 = (d, o = 0) => view(d).getUint32(o, true);
const u64 = (d, o) => view(d).getBigUint64(o, true);
const same = (d, arr) => arr.every((x, i) => d[i] === x);

// b: the block row; fee: the least fee the block must pay; feeWallet: where it goes.
// Returns { seller_sig, fee, escrow } or throws with the reason.
export async function checkBlock(raw, b, { fee = 0n, feeWallet = null } = {}) {
  const t = parseTx(raw);
  const bad = (why) => { throw Object.assign(new Error(why), { status: 400 }); };
  if (t.keys[0] !== b.buyer) bad('the buyer must pay the network fee');
  const sellerAt = t.keys.indexOf(b.seller);
  if (sellerAt < 1 || sellerAt >= t.required) bad('the seller must sign');
  if (!(await verifySig(b.seller, t.sigs[sellerAt], t.message))) bad("the seller's signature does not match");
  if (t.sigs.length !== t.required) bad('wrong number of signatures');
  // the other signers are fresh keys made in the seller's page (the memo tag or the lock base): never the buyer's tokens
  if (t.blockhash !== b.nonce_value) bad('the block must be signed against its nonce');

  const ix0 = t.ixs[0];
  if (!ix0 || ix0.program !== SYSTEM || ix0.data.length !== 4 || u32(ix0.data) !== 4 || ix0.accounts[0] !== b.nonce || ix0.accounts[1] !== RECENT || ix0.accounts[2] !== b.seller) bad('the first step must advance the nonce');

  let price = 0, paid = 0n, feePaid = 0n, moved = 0n, memo = false, escrow = null;
  const atas = new Map(); // wallet -> token account opened for it
  for (const ix of t.ixs.slice(1)) {
    const d = ix.data, a = ix.accounts;
    if (ix.program === COMPUTE) {
      if (d[0] === 2 && d.length === 5 && u32(d, 1) <= MAX_UNITS) continue;
      if (d[0] === 3 && d.length === 9 && u64(d, 1) <= BigInt(MAX_PRICE)) continue;
      bad('the compute budget is out of range');
    } else if (ix.program === SYSTEM) {
      if (d.length !== 12 || u32(d) !== 2 || a[0] !== b.buyer) bad('only payments from the buyer are allowed');
      const n = u64(d, 4);
      if (a[1] === b.seller && !price) { price++; paid = n; } else if (feeWallet && a[1] === feeWallet && !feePaid) feePaid = n; else bad('an unexpected payment');
    } else if (ix.program === ATA) {
      if (d.length !== 1 || d[0] !== 1 || a[0] !== b.buyer || a[3] !== b.mint || a[5] !== b.program) bad('an unexpected token account');
      atas.set(a[2], a[1]);
    } else if (ix.program === b.program && d[0] === 12) {
      // transfer_checked from the seller to the buyer's token account
      if (b.lock_until || d.length !== 10 || a[1] !== b.mint || a[3] !== b.seller || a[2] !== atas.get(b.buyer) || d[9] !== b.decimals) bad('the token transfer is not the block');
      moved += u64(d, 1);
    } else if (ix.program === LOCKER) {
      // create_vesting_escrow_v2: one cliff on the block's date, everything at the cliff, nobody can cancel or redirect it
      if (!b.lock_until || d.length !== 59 || !same(d, CREATE)) bad('the lock is not the block');
      const [start, cliff, freq, cliffAmount, perPeriod, periods] = [8, 16, 24, 32, 40, 48].map((o) => u64(d, o));
      if (Number(cliff) !== b.lock_until || freq !== 1n || perPeriod !== 0n || periods !== 0n || start > cliff || d[56] !== 0 || d[57] !== 0) bad('the lock terms are not the block');
      if (a[2] !== b.mint || a[3] !== atas.get(a[1]) || a[4] !== b.seller || a[6] !== b.buyer || a[7] !== b.program) bad('the lock accounts are not the block');
      escrow = a[1];
      moved += cliffAmount;
    } else if (ix.program === MEMO) {
      if (new TextDecoder().decode(d) !== `plover:${b.id}` || memo) bad('the memo is not the block');
      memo = true;
    } else bad(`a program the block does not use: ${ix.program}`);
  }
  if (moved !== BigInt(b.amount)) bad('the block moves a different amount');
  if (paid !== BigInt(b.lamports)) bad('the block has a different price');
  if (feePaid < fee) bad('the fee is missing');
  if (!memo) bad('the memo is missing');
  // the buyer signs only as the payer; it must not appear anywhere it could lose tokens
  for (const ix of t.ixs) if (ix.program !== SYSTEM && ix.program !== ATA && ix.accounts.includes(b.buyer) && !(ix.program === LOCKER || ix.program === b.program)) bad('the buyer appears where it should not');
  return { seller_sig: b58encode(t.sigs[sellerAt]), fee: String(feePaid), escrow };
}
