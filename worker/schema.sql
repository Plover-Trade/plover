CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  seller TEXT NOT NULL, mint TEXT NOT NULL, program TEXT NOT NULL, decimals INTEGER NOT NULL,
  symbol TEXT, name TEXT, image TEXT, supply TEXT,
  amount TEXT NOT NULL, lamports TEXT NOT NULL, lock_until INTEGER NOT NULL DEFAULT 0,
  buyer TEXT, note TEXT, status TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
  market_lamports TEXT,
  nonce TEXT, nonce_value TEXT, tx TEXT, seller_sig TEXT, fee TEXT, signed_at INTEGER,
  done_sig TEXT, done_at INTEGER
);
CREATE INDEX IF NOT EXISTS blocks_status ON blocks (status, created);
CREATE INDEX IF NOT EXISTS blocks_seller ON blocks (seller);
CREATE INDEX IF NOT EXISTS blocks_buyer ON blocks (buyer);
CREATE TABLE IF NOT EXISTS requests (
  block TEXT NOT NULL, buyer TEXT NOT NULL, note TEXT, created INTEGER NOT NULL,
  PRIMARY KEY (block, buyer)
);
CREATE INDEX IF NOT EXISTS requests_buyer ON requests (buyer);
