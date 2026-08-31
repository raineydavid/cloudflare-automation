// Mint the wallet: generates a fresh private key and prints the key +
// address ONCE, to stdout, for the founder to store as secrets.
// Nothing is written to disk or git. Run:
//   cd workers/wallet-signer && npm install && node generate.mjs
//
// Then:
//   1. `wrangler secret put WALLET_PRIVATE_KEY` (paste the key)
//   2. `wrangler secret put SIGNER_AUTH` (any strong random string)
//   3. Fund the printed ADDRESS with USDC — base-sepolia faucet first
//      (test tokens, real-but-valueless), Base mainnet when ready.
//   4. In Vercel (WorkAIs): SPEND_SIGNER_URL = the worker URL,
//      SPEND_SIGNER_AUTH = the same SIGNER_AUTH value.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
console.log('WALLET_PRIVATE_KEY (platform wallet — store as CF secret, never commit):');
console.log(key);
console.log('\nPlatform ADDRESS (fund this with USDC):');
console.log(account.address);

// A master seed drives per-worker wallets (deterministic, no per-worker
// secret to store). Set it as CF secret WALLET_MASTER_SEED; the signer
// derives each worker's address from it and GET lists them to fund.
const masterSeed = generatePrivateKey().slice(2); // 32 bytes of entropy as the seed
console.log('\nWALLET_MASTER_SEED (per-worker wallets — store as CF secret, never commit):');
console.log(masterSeed);
console.log('\nAfter deploy, GET the worker to list each worker address to fund:');
console.log('  curl https://<worker-url>/  → { platform, workers: { sky, june, … } }');
