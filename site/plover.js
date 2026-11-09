// A PLOVER block: one transaction that swaps a seller's tokens for a buyer's SOL, signed by the seller first and by the buyer later.
// The seller signs against a durable nonce instead of a recent blockhash, so the signature waits for the buyer for days.
//   nonceOpen   a fresh nonce account with the seller as its authority (rent ~0.00145 SOL, comes back on close)
//   block       advance the nonce, tokens seller -> buyer (or into a Jupiter Lock escrow for the buyer), SOL buyer -> seller, fee, memo
//   nonceClose  withdraw everything from the nonce account: the account is gone, and the signed block can never land
// The buyer is written into the block, so a bot cannot take a discounted block and sell it into the pool.
// Works with window.solanaWeb3 in the page and with @solana/web3.js in node (the mainnet simulation).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.Plover = factory(root.solanaWeb3);
})(typeof self !== 'undefined' ? self : this, function (web3) {
  const { PublicKey, TransactionInstruction } = web3;
  const SYSTEM = new PublicKey('11111111111111111111111111111111');
  const LOCKER = new PublicKey('LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn');
  const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const COMPUTE = new PublicKey('ComputeBudget111111111111111111111111111111');
  const RECENT = new PublicKey('SysvarRecentB1ockHashes11111111111111111111');
  const RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
  const NONCE_SIZE = 80, NONCE_RENT = 1447680;
  // sha256("global:create_vesting_escrow_v2")[0..8]
  const CREATE = [181, 155, 104, 183, 182, 128, 35, 47];
  const enc = (s) => new TextEncoder().encode(s);
  const pk = (k) => (k instanceof PublicKey ? k : new PublicKey(k));
  const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const EVENTS = pda([enc('__event_authority')], LOCKER);
  const acc = (pubkey, isSigner, isWritable) => ({ pubkey: pk(pubkey), isSigner, isWritable });

  // u64 as BigInt, u32 as [n] with a length of 4 written by u32(), raw bytes as arrays: the browser build of web3.js has no Buffer
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  function bytes(...parts) {
    const list = parts.map((p) => {
      if (typeof p === 'bigint') { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, p, true); return b; }
      if (typeof p === 'string') return enc(p);
      return Uint8Array.from(p);
    });
    const out = new Uint8Array(list.reduce((t, b) => t + b.length, 0));
    let at = 0; for (const b of list) { out.set(b, at); at += b.length; }
    return out;
  }

  const ataOf = (owner, mint, program = TOKEN) => pda([pk(owner).toBytes(), pk(program).toBytes(), pk(mint).toBytes()], ATA);
  const escrowOf = (base) => pda([enc('escrow'), pk(base).toBytes()], LOCKER);
  const openAta = (payer, owner, mint, program) => new TransactionInstruction({
    programId: ATA, data: Uint8Array.from([1]),
    keys: [acc(payer, true, true), acc(ataOf(owner, mint, program), false, true), acc(owner, false, false), acc(mint, false, false), acc(SYSTEM, false, false), acc(program, false, false)],
  });
  const transfer = (from, to, lamports) => new TransactionInstruction({ programId: SYSTEM, data: bytes(u32(2), BigInt(lamports)), keys: [acc(from, true, true), acc(to, false, true)] });
  const budget = (units, microLamports) => [
    new TransactionInstruction({ programId: COMPUTE, data: bytes([2], u32(units)), keys: [] }),
    new TransactionInstruction({ programId: COMPUTE, data: bytes([3], BigInt(microLamports)), keys: [] }),
  ];

  // two signers: the seller pays, the new nonce account signs its own creation
  function nonceOpen({ seller, nonce }) {
    return [
      new TransactionInstruction({ programId: SYSTEM, data: bytes(u32(0), BigInt(NONCE_RENT), BigInt(NONCE_SIZE), SYSTEM.toBytes()), keys: [acc(seller, true, true), acc(nonce, true, true)] }),
      new TransactionInstruction({ programId: SYSTEM, data: bytes(u32(6), pk(seller).toBytes()), keys: [acc(nonce, false, true), acc(RECENT, false, false), acc(RENT, false, false)] }),
    ];
  }
  const advance = (nonce, authority) => new TransactionInstruction({ programId: SYSTEM, data: bytes(u32(4)), keys: [acc(nonce, false, true), acc(RECENT, false, false), acc(authority, true, false)] });
  const nonceClose = ({ seller, nonce, lamports }) => [new TransactionInstruction({ programId: SYSTEM, data: bytes(u32(5), BigInt(lamports)), keys: [acc(nonce, false, true), acc(seller, false, true), acc(RECENT, false, false), acc(RENT, false, false), acc(seller, true, false)] })];

  // nonce account: version u32, state u32, authority, the stored blockhash, fee calculator
  function readNonce(data) {
    const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
    if (b.length !== NONCE_SIZE) return null;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (v.getUint32(4, true) !== 1) return null;
    return { authority: new PublicKey(b.subarray(8, 40)), value: new PublicKey(b.subarray(40, 72)).toBase58() };
  }

  // { seller, buyer, mint, program, decimals, amount (raw), lamports, fee, feeWallet, nonce, id,
  //   lockUntil (unix seconds, optional), signedAt (unix seconds), base (fresh key, with lockUntil), tag (fresh key, without) }
  // The buyer pays the network fee and opens the token account that receives the block.
  function block({ seller, buyer, mint, program = TOKEN, decimals, amount, lamports, fee = 0, feeWallet = null, nonce, id, lockUntil = 0, signedAt, base, tag, price = 20000 }) {
    if (!(BigInt(amount) > 0n)) throw new Error('the block is empty');
    if (!(BigInt(lamports) > 0n)) throw new Error('the block needs a price');
    if (pk(buyer).equals(pk(seller))) throw new Error('the buyer must be another wallet');
    const source = ataOf(seller, mint, program);
    const ixs = [advance(nonce, seller), ...budget(lockUntil ? 120000 : 60000, price)];
    if (lockUntil) {
      if (!(lockUntil > signedAt)) throw new Error('the lock must end in the future');
      const escrow = escrowOf(base);
      ixs.push(
        openAta(buyer, escrow, mint, program),
        new TransactionInstruction({
          programId: LOCKER,
          // vesting_start_time, cliff_time, frequency, cliff_unlock_amount, amount_per_period, number_of_period,
          // update_recipient_mode 0 and cancel_mode 0: nobody can move or cancel it, not even the seller; no remaining accounts
          data: bytes(CREATE, BigInt(signedAt), BigInt(lockUntil), 1n, BigInt(amount), 0n, 0n, [0, 0, 0]),
          keys: [
            acc(base, true, true), acc(escrow, false, true), acc(mint, false, false), acc(ataOf(escrow, mint, program), false, true),
            acc(seller, true, true), acc(source, false, true), acc(buyer, false, false),
            acc(program, false, false), acc(SYSTEM, false, false), acc(EVENTS, false, false), acc(LOCKER, false, false),
          ],
        }),
      );
    } else {
      ixs.push(
        openAta(buyer, buyer, mint, program),
        // transfer_checked: the mint and its decimals are part of what the seller signs
        new TransactionInstruction({ programId: program, data: bytes([12], BigInt(amount), [decimals]), keys: [acc(source, false, true), acc(mint, false, false), acc(ataOf(buyer, mint, program), false, true), acc(seller, true, false)] }),
      );
    }
    ixs.push(transfer(buyer, seller, lamports));
    if (fee > 0 && feeWallet) ixs.push(transfer(buyer, feeWallet, fee));
    // the memo names the block; without a lock a fresh tag key signs it, so a wallet sees a transaction that is already signed by someone
    ixs.push(new TransactionInstruction({ programId: MEMO, data: bytes(`plover:${id}`), keys: lockUntil ? [] : [acc(tag, true, false)] }));
    return { ixs, escrow: lockUntil ? escrowOf(base) : null };
  }

  return { SYSTEM, LOCKER, MEMO, TOKEN, TOKEN_2022, NONCE_RENT, NONCE_SIZE, nonceOpen, nonceClose, readNonce, block, budget, ataOf, escrowOf };
});
