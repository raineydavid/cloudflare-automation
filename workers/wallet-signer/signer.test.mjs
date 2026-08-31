// The stablecoin wallet signer's pure half — payment-requirement
// validation and header encoding, pinned without a network.
import { describe, it, expect } from 'vitest';
import { buildAuthorization, encodePaymentHeader, deriveWorkerPrivateKey, capUsdFor, withinCap } from './src/index.mjs';
import { privateKeyToAccount } from 'viem/accounts';

const base = {
  scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '250000',
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
const FROM = '0x1f6ce13b2CBf1170419cfBE837a60b7290bF5507';

describe('buildAuthorization', () => {
  it('builds a valid USDC transfer authorization', () => {
    const { authorization, domain, network } = buildAuthorization(base, FROM, 1_000_000);
    expect(authorization.from).toBe(FROM);
    expect(authorization.to).toBe(base.payTo);
    expect(authorization.value).toBe('250000'); // $0.25 USDC
    expect(authorization.validBefore).toBe(String(1_000_000 + 600));
    expect(authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(domain.chainId).toBe(84532);
    expect(domain.verifyingContract).toBe(base.asset);
    expect(network).toBe('base-sepolia');
  });

  it('honours the asset EIP-712 domain from requirements.extra', () => {
    const { domain } = buildAuthorization({ ...base, extra: { name: 'USD Coin', version: '3' } }, FROM, 0);
    expect(domain.name).toBe('USD Coin');
    expect(domain.version).toBe('3');
  });

  it('maps mainnet base to the right chain id', () => {
    expect(buildAuthorization({ ...base, network: 'base' }, FROM, 0).domain.chainId).toBe(8453);
  });

  it('refuses non-stablecoin chains and non-exact schemes', () => {
    expect(() => buildAuthorization({ ...base, network: 'ethereum' }, FROM, 0)).toThrow(/unsupported network/);
    expect(() => buildAuthorization({ ...base, scheme: 'upto' }, FROM, 0)).toThrow(/unsupported scheme/);
  });

  it('refuses malformed payment requirements', () => {
    expect(() => buildAuthorization({ ...base, payTo: 'nope' }, FROM, 0)).toThrow(/payTo/);
    expect(() => buildAuthorization({ ...base, asset: '' }, FROM, 0)).toThrow(/asset/);
    expect(() => buildAuthorization({ ...base, maxAmountRequired: 'lots' }, FROM, 0)).toThrow(/maxAmountRequired/);
  });
});

describe('deriveWorkerPrivateKey — per-worker wallets', () => {
  const SEED = 'test-master-seed-do-not-use-in-prod';

  it('is deterministic: same worker → same address', async () => {
    const a = privateKeyToAccount(await deriveWorkerPrivateKey(SEED, 'sky')).address;
    const b = privateKeyToAccount(await deriveWorkerPrivateKey(SEED, 'sky')).address;
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('different workers → different addresses', async () => {
    const sky = privateKeyToAccount(await deriveWorkerPrivateKey(SEED, 'sky')).address;
    const june = privateKeyToAccount(await deriveWorkerPrivateKey(SEED, 'june')).address;
    expect(sky).not.toBe(june);
  });

  it('a different master seed → different addresses', async () => {
    const s1 = privateKeyToAccount(await deriveWorkerPrivateKey(SEED, 'sky')).address;
    const s2 = privateKeyToAccount(await deriveWorkerPrivateKey('other-seed', 'sky')).address;
    expect(s1).not.toBe(s2);
  });

  it('produces a valid 32-byte secp256k1 key', async () => {
    const pk = await deriveWorkerPrivateKey(SEED, 'marcus');
    expect(pk).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => privateKeyToAccount(pk)).not.toThrow();
  });

  it('rejects missing seed / invalid worker id', async () => {
    await expect(deriveWorkerPrivateKey('', 'sky')).rejects.toThrow(/master seed/);
    await expect(deriveWorkerPrivateKey(SEED, 'Bad Id!')).rejects.toThrow(/invalid worker/);
  });
});

describe('per-worker spend caps — the mandate ceiling', () => {
  it('resolves a worker-specific cap, else the platform default, else null', () => {
    const env = { WALLET_WORKER_CAPS: '{"june":"5","sky":"0"}', WALLET_MAX_USD: '2' };
    expect(capUsdFor(env, 'june')).toBe(5);
    expect(capUsdFor(env, 'sky')).toBe(0);        // an explicit 0 means "no spend"
    expect(capUsdFor(env, 'marcus')).toBe(2);     // falls back to platform default
    expect(capUsdFor(env, null)).toBe(2);
    expect(capUsdFor({}, 'june')).toBeNull();     // nothing configured → no cap
  });

  it('ignores malformed cap config rather than throwing', () => {
    expect(capUsdFor({ WALLET_WORKER_CAPS: 'not json' }, 'june')).toBeNull();
    expect(capUsdFor({ WALLET_WORKER_CAPS: '{"june":"nope"}' }, 'june')).toBeNull();
  });

  it('withinCap gates atomic value against the USDC cap', () => {
    // cap $5 USDC → 5_000_000 atomic (6 decimals)
    expect(withinCap('4000000', 5).ok).toBe(true);
    expect(withinCap('5000000', 5).ok).toBe(true);   // exactly at the cap is allowed
    expect(withinCap('5000001', 5).ok).toBe(false);  // one unit over is not
    expect(withinCap('5000000', 5).capAtomic).toBe('5000000');
  });

  it('no cap (null) always passes; an explicit 0 blocks any spend', () => {
    expect(withinCap('999999999', null).ok).toBe(true);
    expect(withinCap('1', 0).ok).toBe(false);
    expect(withinCap('0', 0).ok).toBe(true);
  });

  it('respects a non-6 decimals from requirements.extra', () => {
    // cap $1 at 2 decimals → 100 atomic
    expect(withinCap('100', 1, 2).ok).toBe(true);
    expect(withinCap('101', 1, 2).ok).toBe(false);
  });
});

describe('encodePaymentHeader', () => {
  it('produces a decodable x402 v1 header', () => {
    const header = encodePaymentHeader({ network: 'base', authorization: { from: FROM, value: '250000' }, signature: '0xabc' });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('base');
    expect(decoded.payload.signature).toBe('0xabc');
    expect(decoded.payload.authorization.value).toBe('250000');
  });
});
