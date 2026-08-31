/**
 * Wallet signer — the WorkAIs stablecoin wallet's signing half.
 *
 * A Cloudflare Worker holding the wallet's private key (CF secret,
 * never in any app process — the exact separation x402Pay.js was
 * designed around). WorkAIs' payAndFetch POSTs the 402 payment
 * requirements here; we sign an EIP-3009 transferWithAuthorization
 * for USDC (x402 v1 "exact" scheme) and hand back the X-PAYMENT
 * header. Stablecoins only: USDC on base-sepolia (test tokens) or
 * base (real money — dual-control gated upstream in spendApproval).
 *
 * Contract (matches api/_lib/x402Pay.js signPayment):
 *   POST / { x402Version: 1, paymentRequirements } → { xPaymentHeader }
 *   Auth: Bearer SIGNER_AUTH
 *
 * Secrets: WALLET_PRIVATE_KEY (0x…32-byte hex), SIGNER_AUTH.
 * GET / reports configuration + wallet address — never the key.
 */

import { privateKeyToAccount } from 'viem/accounts';

const CHAIN_IDS = { 'base': 8453, 'base-sepolia': 84532 };

// EIP-3009 typed-data shape for USDC transferWithAuthorization.
const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function randomNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const USDC_DECIMALS = 6;

/**
 * Per-worker spend cap — the enforcement half of a worker's mandate. You
 * don't arm a wallet without a ceiling: this is what stops a runaway worker
 * draining its address. Read from WALLET_WORKER_CAPS (JSON, USDC, e.g.
 * {"june":"5","sky":"3"}) with WALLET_MAX_USD as the default for anyone not
 * listed. No config → null → no cap, so nothing changes until the founder
 * sets mandates. Returns a non-negative number of USDC, or null.
 */
export function capUsdFor(env, worker) {
  let map = {};
  try { map = env.WALLET_WORKER_CAPS ? JSON.parse(env.WALLET_WORKER_CAPS) : {}; } catch { map = {}; }
  const specific = worker != null && map[worker] != null ? map[worker] : undefined;
  const raw = specific != null ? specific : env.WALLET_MAX_USD;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Pure cap check: is an atomic-unit `value` within `capUsd` at `decimals`?
 * capUsd null → always ok (no mandate set). Integer math on the atomic cap
 * so float dust never lets a spend sneak over. Returns {ok, capAtomic}.
 */
export function withinCap(valueAtomic, capUsd, decimals = USDC_DECIMALS) {
  if (capUsd == null) return { ok: true, capAtomic: null };
  const capAtomic = BigInt(Math.round(capUsd * 10 ** decimals));
  return { ok: BigInt(valueAtomic) <= capAtomic, capAtomic: capAtomic.toString() };
}

/** Build the unsigned authorization + EIP-712 envelope from x402
 *  payment requirements. Pure — unit-testable without a key. */
export function buildAuthorization(requirements, fromAddress, nowSeconds) {
  const network = String(requirements?.network || '');
  const chainId = CHAIN_IDS[network];
  if (!chainId) throw new Error(`unsupported network: ${network} (stablecoin wallet speaks base/base-sepolia)`);
  if (String(requirements?.scheme) !== 'exact') throw new Error(`unsupported scheme: ${requirements?.scheme}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(requirements?.payTo || ''))) throw new Error('missing/invalid payTo');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(requirements?.asset || ''))) throw new Error('missing/invalid asset (USDC contract)');
  const value = String(parseInt(requirements.maxAmountRequired, 10));
  if (!/^\d+$/.test(value) || value === 'NaN') throw new Error('missing/invalid maxAmountRequired');

  const authorization = {
    from: fromAddress,
    to: requirements.payTo,
    value,
    validAfter: '0',
    validBefore: String(nowSeconds + 600),
    nonce: randomNonce(),
  };
  // The asset's EIP-712 domain rides in requirements.extra per the
  // x402 spec; sensible USDC defaults otherwise.
  const domain = {
    name: requirements.extra?.name || 'USDC',
    version: requirements.extra?.version || '2',
    chainId,
    verifyingContract: requirements.asset,
  };
  return { authorization, domain, network };
}

export function encodePaymentHeader({ network, authorization, signature }) {
  const payload = { x402Version: 1, scheme: 'exact', network, payload: { signature, authorization } };
  return btoa(JSON.stringify(payload));
}

// The roster whose addresses GET lists. On-demand POST can derive any
// worker id; this is just the set surfaced for attribution.
const DEFAULT_WORKERS = ['sky', 'june', 'marcus', 'elias', 'nova'];

/**
 * Per-worker wallet: a deterministic key derived from the master seed +
 * worker id (HMAC-SHA256), so every worker has its own stable address
 * with no per-worker secret to store. Same worker → same address;
 * different workers → different addresses. Returns a 0x 32-byte hex key.
 */
export async function deriveWorkerPrivateKey(masterSeed, workerId) {
  if (!masterSeed) throw new Error('master seed required');
  if (!workerId || !/^[a-z0-9-]{1,40}$/.test(workerId)) throw new Error('invalid worker id');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(masterSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`workais:worker:${workerId}`));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `0x${hex}`; // HMAC-SHA256 is 32 bytes — a valid secp256k1 key
}

/** Resolve the signing account: a worker's derived key when `worker` is
 *  given and a master seed exists, else the platform key. */
async function resolveAccount(env, worker) {
  if (worker && env.WALLET_MASTER_SEED) {
    return privateKeyToAccount(await deriveWorkerPrivateKey(env.WALLET_MASTER_SEED, worker));
  }
  if (env.WALLET_PRIVATE_KEY) return privateKeyToAccount(env.WALLET_PRIVATE_KEY);
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      const configured = !!((env.WALLET_PRIVATE_KEY || env.WALLET_MASTER_SEED) && env.SIGNER_AUTH);
      let address = null;
      if (env.WALLET_PRIVATE_KEY) {
        try { address = privateKeyToAccount(env.WALLET_PRIVATE_KEY).address; } catch {}
      }
      // Per-worker addresses for attribution (addresses only, never keys)
      // and each worker's spend cap (the mandate ceiling) so the platform
      // can show "june: ≤ $5" without holding any secret.
      const workers = {};
      const caps = {};
      if (env.WALLET_MASTER_SEED) {
        const roster = (env.WALLET_WORKERS || DEFAULT_WORKERS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
        for (const w of roster) {
          try { workers[w] = privateKeyToAccount(await deriveWorkerPrivateKey(env.WALLET_MASTER_SEED, w)).address; } catch {}
          const c = capUsdFor(env, w);
          if (c != null) caps[w] = c;
        }
      }
      const platformCap = capUsdFor(env, null);
      return Response.json({ service: 'workais-wallet-signer', configured, platform: address, workers, caps, platformCap, networks: Object.keys(CHAIN_IDS) });
    }
    if (request.method !== 'POST') return Response.json({ error: 'GET or POST only' }, { status: 405 });

    if ((!env.WALLET_PRIVATE_KEY && !env.WALLET_MASTER_SEED) || !env.SIGNER_AUTH) {
      return Response.json({ error: 'signer not configured (WALLET_PRIVATE_KEY or WALLET_MASTER_SEED, and SIGNER_AUTH, missing)' }, { status: 503 });
    }
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.SIGNER_AUTH}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const requirements = body?.paymentRequirements;
    if (!requirements) return Response.json({ error: 'paymentRequirements required' }, { status: 400 });

    try {
      // Optional `worker` scopes the spend to that worker's address; the
      // caller attributes ledger entries by the same id.
      const account = await resolveAccount(env, body?.worker);
      if (!account) return Response.json({ error: `no key for worker ${body?.worker || '(platform)'}` }, { status: 400 });
      const { authorization, domain, network } = buildAuthorization(requirements, account.address, Math.floor(Date.now() / 1000));
      // Mandate enforcement: reject a spend over this worker's cap before
      // signing anything. The signer is the last line — even a compromised
      // caller can't move more than the founder authorised per worker.
      const cap = capUsdFor(env, body?.worker);
      const capCheck = withinCap(authorization.value, cap, Number(requirements.extra?.decimals ?? USDC_DECIMALS));
      if (!capCheck.ok) {
        return Response.json({
          error: `spend exceeds mandate cap for ${body?.worker || 'platform'} (${cap} USDC)`,
          worker: body?.worker || null, value: authorization.value, capAtomic: capCheck.capAtomic,
        }, { status: 403 });
      }
      const signature = await account.signTypedData({
        domain,
        types: TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
      });
      return Response.json({
        xPaymentHeader: encodePaymentHeader({ network, authorization, signature }),
        worker: body?.worker || null,
        from: account.address,
      });
    } catch (e) {
      return Response.json({ error: String(e.message || e) }, { status: 400 });
    }
  },
};
