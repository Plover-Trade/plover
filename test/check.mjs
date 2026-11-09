// Mainnet simulation of plover.js on real wallets. No keys and no funds: signatures are not checked.
// The nonce advance is left out of the block simulations (there is no nonce account for these wallets); it is checked on its own.
// Run: RPC=<helius url> node check.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const R = require('../site/plover.js')(web3);
const { PublicKey, Connection, TransactionMessage, VersionedTransaction, Keypair } = web3;

const c = new Connection(process.env.RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
const now = Math.floor(Date.now() / 1000);
let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };

async function simulate(payer, ixs, watch = []) {
  const { blockhash } = await c.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const r = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: watch.map(String) } });
  const after = (r.value.accounts || []).map((a) => (!a ? null : { lamports: a.lamports, data: Buffer.from(a.data[0], 'base64') }));
  return { err: r.value.err, size: tx.serialize().length, units: r.value.unitsConsumed, logs: (r.value.logs || []).filter((l) => /rror|failed|insufficient/i.test(l)).slice(-3), after };
}
const show = (r) => (r.err ? `err ${JSON.stringify(r.err)} ${r.logs.join(' ')}` : `${r.size}/1232 bytes, ${r.units} CU`);
const tokenAmount = (a) => (a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : null);

// a pump token (Token-2022) and one of its holders as the seller; a wallet with SOL as the buyer
const MINT = new PublicKey(process.env.MINT || 'EVNuBvvk5RgqKVStMEV9ha9nnZ3ZPeUVS1byL4Udpump');
const mintAcc = await c.getParsedAccountInfo(MINT);
const program = mintAcc.value.owner, decimals = mintAcc.value.data.parsed.info.decimals;
let seller = null, have = 0n;
if (process.env.SELLER) {
  seller = new PublicKey(process.env.SELLER);
  have = BigInt((await c.getParsedAccountInfo(R.ataOf(seller, MINT, program))).value.data.parsed.info.tokenAmount.amount);
}
for (const l of seller ? [] : (await c.getTokenLargestAccounts(MINT)).value.slice(1, 12)) {
  const info = (await c.getParsedAccountInfo(l.address)).value.data.parsed.info;
  const owner = new PublicKey(info.owner);
  if (PublicKey.isOnCurve(owner.toBytes()) && R.ataOf(owner, MINT, program).equals(l.address)) { seller = owner; have = BigInt(info.tokenAmount.amount); break; }
}
const buyer = new PublicKey(process.env.BUYER || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
console.log(`mint ${MINT} (${program.equals(R.TOKEN_2022) ? 'Token-2022' : 'Token'}, ${decimals} dp), seller ${seller}, holds ${have}, buyer ${buyer} has ${(await c.getBalance(buyer)) / 1e9} SOL`);
const feeWallet = new PublicKey('HELnQfJ9mtWX4eoyxQaQF1q53yBAjjxAhGLNYFJdMMxi');
const amount = have / 2n, lamports = 10_000_000n, fee = 50_000n;
const strip = (ixs) => ixs.slice(1); // the nonce advance

// 1 a plain block: tokens and SOL change hands, the fee lands
{
  const tag = Keypair.generate().publicKey;
  const { ixs } = R.block({ seller, buyer, mint: MINT, program, decimals, amount, lamports, fee, feeWallet, nonce: Keypair.generate().publicKey, id: 'test1', signedAt: now, tag });
  const before = await c.getMultipleAccountsInfo([seller, feeWallet]);
  const r = await simulate(buyer, strip(ixs), [R.ataOf(buyer, MINT, program), R.ataOf(seller, MINT, program), seller, feeWallet]);
  const got = tokenAmount(r.after[0]), left = tokenAmount(r.after[1]);
  ok('1 plain block', !r.err && got === amount && left === have - amount && BigInt(r.after[2].lamports - before[0].lamports) === lamports && BigInt(r.after[3].lamports - before[1].lamports) === fee,
    `${show(r)} | buyer got ${got}, seller left ${left}`);
}

// 2 a locked block: the tokens sit in a Jupiter Lock escrow for the buyer until the date, nobody can cancel
{
  const base = Keypair.generate().publicKey, until = now + 30 * 86400;
  const { ixs, escrow } = R.block({ seller, buyer, mint: MINT, program, decimals, amount, lamports, fee, feeWallet, nonce: Keypair.generate().publicKey, id: 'test2', lockUntil: until, signedAt: now - 3 * 86400, base });
  const r = await simulate(buyer, strip(ixs), [R.ataOf(escrow, MINT, program), escrow]);
  const e = r.after[1]?.data;
  const recipient = e && new PublicKey(e.subarray(8, 40)), cliff = e && Number(e.readBigUInt64LE(144)), cancel = e && e[138];
  ok('2 locked block (signed 3 days before it lands)', !r.err && tokenAmount(r.after[0]) === amount && recipient?.equals(buyer) && cliff === until && cancel === 0,
    `${show(r)} | escrow holds ${tokenAmount(r.after[0])}, recipient ${recipient}, cliff ${cliff}, cancel_mode ${cancel}`);
}

// 3 the seller sold elsewhere: the block fails as a whole, nobody pays
{
  const { ixs } = R.block({ seller, buyer, mint: MINT, program, decimals, amount: have + 1n, lamports, fee, feeWallet, nonce: Keypair.generate().publicKey, id: 'test3', signedAt: now, tag: Keypair.generate().publicKey });
  const r = await simulate(buyer, strip(ixs));
  ok('3 seller no longer has the tokens -> whole block fails', !!r.err, show(r));
}

// 4 a buyer without the SOL: fails as a whole
{
  const poor = Keypair.generate().publicKey;
  const { ixs } = R.block({ seller, buyer: poor, mint: MINT, program, decimals, amount, lamports, nonce: Keypair.generate().publicKey, id: 'test4', signedAt: now, tag: Keypair.generate().publicKey });
  const r = await simulate(buyer, strip(ixs));
  ok('4 buyer cannot pay -> whole block fails', !!r.err, show(r));
}

// 5 nonce account: open it, then the advance and the close work on a nonce made in the same transaction
{
  const nonce = Keypair.generate().publicKey;
  const r = await simulate(seller, [...R.nonceOpen({ seller, nonce })], [nonce]);
  const n = r.after[0] && R.readNonce(r.after[0].data);
  ok('5 nonce opens with the seller as authority', !r.err && n?.authority.equals(seller) && r.after[0].lamports === R.NONCE_RENT, `${show(r)} | value ${n?.value}`);
  const r2 = await simulate(seller, [...R.nonceOpen({ seller, nonce }), ...R.nonceClose({ seller, nonce, lamports: R.NONCE_RENT })], [nonce]);
  // a nonce cannot be used in the slot it was made in (Custom 7, NonceBlockhashNotExpired): reaching that check means the close is well formed
  ok('6 nonce close reaches the nonce check', JSON.stringify(r2.err) === '{"InstructionError":[2,{"Custom":7}]}', show(r2));
}

// 7 size of the biggest real transaction: the locked block with the advance and four signatures
{
  const { ixs } = R.block({ seller, buyer, mint: MINT, program, decimals, amount, lamports, fee, feeWallet, nonce: Keypair.generate().publicKey, id: 'b_7f3k9q2m', lockUntil: now + 9e6, signedAt: now, base: Keypair.generate().publicKey });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: buyer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message());
  ok('7 locked block fits', tx.serialize().length <= 1232, `${tx.serialize().length}/1232 bytes, ${tx.message.header.numRequiredSignatures} signatures`);
}

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
