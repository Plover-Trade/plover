// checkBlock against blocks built by plover.js and signed by a throwaway seller key, plus tampered versions it must refuse.
// Offline: no RPC. Run: node tx-test.mjs
import { createRequire } from 'node:module';
import { checkBlock, parseTx } from '../worker/src/tx.js';
const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const R = require('../site/plover.js')(web3);
const { Keypair, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction } = web3;

let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const seller = Keypair.generate(), buyer = Keypair.generate().publicKey, nonce = Keypair.generate().publicKey;
const mint = new PublicKey('EVNuBvvk5RgqKVStMEV9ha9nnZ3ZPeUVS1byL4Udpump'), program = R.TOKEN_2022;
const feeWallet = 'HELnQfJ9mtWX4eoyxQaQF1q53yBAjjxAhGLNYFJdMMxi';
const nonceValue = Keypair.generate().publicKey.toBase58();
const now = Math.floor(Date.now() / 1000);
const row = (o = {}) => ({ id: 'babc12345', seller: seller.publicKey.toBase58(), buyer: buyer.toBase58(), mint: mint.toBase58(), program: program.toBase58(), decimals: 6, amount: '1000000000', lamports: '250000000', lock_until: 0, nonce: nonce.toBase58(), nonce_value: nonceValue, ...o });

function build(b, { extra = [], edit = (ixs) => ixs, signer = seller } = {}) {
  const tag = Keypair.generate(), base = Keypair.generate();
  let { ixs } = R.block({ seller: seller.publicKey, buyer, mint, program, decimals: 6, amount: BigInt(b.amount), lamports: BigInt(b.lamports), fee: 1250000n, feeWallet: new PublicKey(feeWallet), nonce, id: b.id, lockUntil: b.lock_until, signedAt: now, base: base.publicKey, tag: tag.publicKey });
  ixs = edit([...ixs, ...extra]);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: buyer, recentBlockhash: nonceValue, instructions: ixs }).compileToV0Message());
  tx.sign([signer, b.lock_until ? base : tag].filter((k) => tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).some((x) => x.equals(k.publicKey))));
  return tx.serialize();
}
async function expect(name, raw, b, good) {
  try { const r = await checkBlock(raw, b, { fee: 1250000n, feeWallet }); ok(name, good, good ? `escrow ${r.escrow || 'none'}` : 'accepted a bad block'); }
  catch (e) { ok(name, !good, e.message); }
}

await expect('plain block passes', build(row()), row(), true);
await expect('locked block passes', build(row({ lock_until: now + 30 * 86400 })), row({ lock_until: now + 30 * 86400 }), true);
await expect('different price refused', build(row({ lamports: '1' })), row(), false);
await expect('different amount refused', build(row({ amount: '5' })), row(), false);
await expect('another buyer refused', build(row()), row({ buyer: Keypair.generate().publicKey.toBase58() }), false);
await expect('another nonce value refused', build(row()), row({ nonce_value: Keypair.generate().publicKey.toBase58() }), false);
await expect('lock date changed refused', build(row({ lock_until: now + 30 * 86400 })), row({ lock_until: now + 31 * 86400 }), false);
await expect('signed by someone else refused', build(row(), { signer: Keypair.generate() }), row(), false);
const drain = R.ataOf(buyer, new PublicKey('EPjFWJd5AufqSSqeM2qFxw9zWdBGYkhcvqyAvBTwvdcy'));
await expect('extra SOL out of the buyer refused', build(row(), { extra: [new TransactionInstruction({ programId: R.SYSTEM, data: Uint8Array.from([2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]), keys: [{ pubkey: buyer, isSigner: true, isWritable: true }, { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }] })] }), row(), false);
await expect('buyer token drain refused', build(row(), { extra: [new TransactionInstruction({ programId: R.TOKEN, data: Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]), keys: [{ pubkey: drain, isSigner: false, isWritable: true }, { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, { pubkey: buyer, isSigner: true, isWritable: false }] })] }), row(), false);
await expect('fee left out refused', build(row(), { edit: (ixs) => ixs.filter((ix) => !(ix.programId.equals(R.SYSTEM) && ix.keys[1]?.pubkey.toBase58() === feeWallet)) }), row(), false);
await expect('nonce advance left out refused', build(row(), { edit: (ixs) => ixs.slice(1) }), row(), false);
const raw = build(row()); const t = parseTx(raw); raw[t.message.byteOffset - raw.byteOffset + 40] ^= 1;
await expect('a byte flipped after signing refused', raw, row(), false);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
