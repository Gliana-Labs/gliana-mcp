/**
 * Pay a GlianaAI 402 from a NEAR account, with no EVM private key anywhere.
 *
 * NEAR's Chain Signatures MPC (`v1.signer`, 17 participants, threshold 11)
 * signs an arbitrary 32-byte hash on secp256k1 and returns {r, s, v}. An
 * EIP-3009 `transferWithAuthorization` is exactly that: an ECDSA signature
 * over an EIP-712 digest. So a NEAR account can authorise a USDC transfer on
 * Base without ever holding a Base key — the key is a threshold of NEAR
 * validators, and the address is derived from the account id plus a path.
 *
 * WHAT THIS IS NOT: a new payment rail. The gateway already issues and settles
 * Base challenges and does not care what produced the signature. Everything
 * here is client-side.
 *
 * The signer is INJECTED rather than imported. Signing needs a funded NEAR
 * account and gas, so every other step — reading the challenge, building the
 * typed data, hashing it, assembling the header — is pure and testable with a
 * fake signer, and only the one call that costs money is left to integrate.
 */
import { hashTypedData, isAddress, type Hex } from 'viem';

/** What Chain Signatures hands back, and what EIP-3009 needs. Same shape. */
export interface Rsv {
  r: Hex;
  s: Hex;
  /** 27 or 28. chainsig.js returns 0/1; `toSignature` normalises either. */
  v: number;
}

/** Signs a 32-byte digest. In production this is v1.signer via chainsig.js. */
export type HashSigner = (digest: Hex) => Promise<Rsv>;

/** One option out of a 402 challenge, as the gateway publishes it. */
export interface Accept {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource?: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string } | null;
}

export interface Challenge {
  x402Version?: number;
  accepts?: Accept[];
  error?: string;
}

/**
 * EVM networks we can authorise, by the name the challenge uses.
 *
 * Solana is deliberately absent. Its `exact` scheme signs a serialized
 * transaction, not an EIP-712 digest, so the same MPC primitive would need a
 * different construction — possible, but a separate piece of work and not
 * something to half-ship behind the same function.
 */
export const EVM_CHAIN_IDS: Record<string, number> = {
  base: 8453,
  'eip155:8453': 8453,
  'base-sepolia': 84532,
  'eip155:84532': 84532,
};

/** Pick the option this payer can actually sign, not just the first one. */
export function selectAccept(challenge: Challenge): Accept | null {
  for (const a of challenge.accepts ?? []) {
    if (a.scheme !== 'exact') continue;
    if (!(a.network in EVM_CHAIN_IDS)) continue;
    if (!isAddress(a.payTo) || !isAddress(a.asset)) continue;
    return a;
  }
  return null;
}

/**
 * A random 32-byte nonce.
 *
 * EIP-3009 nonces are arbitrary and single-use — the token contract records
 * each one — so they are NOT sequential and must not be derived from
 * anything guessable. Reusing one makes the second authorisation
 * unredeemable, which on this rail means a paid call that cannot settle.
 */
export function randomNonce(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}` as Hex;
}

export interface Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

/**
 * The EIP-712 digest the MPC has to sign.
 *
 * `extra` carries the token's own EIP-712 domain — USDC on Base is
 * {name: "USD Coin", version: "2"} — and it comes from the challenge rather
 * than a table here, because a domain that disagrees with the contract
 * produces a signature that recovers to the wrong address and is rejected at
 * verify with no useful error.
 */
export function authorizationDigest(accept: Accept, auth: Authorization): Hex {
  const chainId = EVM_CHAIN_IDS[accept.network];
  if (!chainId) throw new Error(`No EVM chain id for network "${accept.network}".`);
  return hashTypedData({
    domain: {
      name: accept.extra?.name ?? 'USD Coin',
      version: accept.extra?.version ?? '2',
      chainId,
      verifyingContract: accept.asset as Hex,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
}

/**
 * {r,s,v} -> the 65-byte signature the facilitator verifies.
 *
 * chainsig.js reports v as a recovery id (0 or 1) while EIP-3009 wants 27 or
 * 28. Accepting both and normalising here means a caller cannot get it subtly
 * wrong: an off-by-27 recovers a different address and fails verification
 * looking exactly like a wrong key.
 */
export function toSignature({ r, s, v }: Rsv): Hex {
  const hex = (x: string) => x.replace(/^0x/, '').padStart(64, '0');
  const rec = v === 0 || v === 1 ? v + 27 : v;
  if (rec !== 27 && rec !== 28) throw new Error(`Unusable recovery id ${v}; expected 0, 1, 27 or 28.`);
  return `0x${hex(r)}${hex(s)}${rec.toString(16)}` as Hex;
}

/**
 * Build the authorization for one call.
 *
 * `validAfter` is backdated by a minute. Facilitators compare it against
 * THEIR clock, and a signature stamped "valid from now" loses to a node a few
 * seconds behind — a failure that looks like a bad signature rather than a
 * clock difference.
 */
export function buildAuthorization(accept: Accept, from: Hex, now = Date.now()): Authorization {
  const sec = Math.floor(now / 1000);
  const window = accept.maxTimeoutSeconds ?? 600;
  return {
    from,
    to: accept.payTo as Hex,
    value: accept.maxAmountRequired,
    validAfter: String(sec - 60),
    validBefore: String(sec + window),
    nonce: randomNonce(),
  };
}

/**
 * The X-PAYMENT header value.
 *
 * x402 v1 shape, because that is what this gateway answers with — its
 * challenge carries `x402Version: 1` and short network names ("base", not
 * "eip155:8453"). The network is echoed back exactly as received so the
 * server matches it against the option it offered.
 */
export function paymentHeader(accept: Accept, auth: Authorization, signature: Hex): string {
  const payload = {
    x402Version: 1,
    scheme: accept.scheme,
    network: accept.network,
    payload: { signature, authorization: auth },
  };
  return btoa(JSON.stringify(payload));
}

export interface PayResult {
  status: number;
  body: unknown;
  /** µUSD actually authorised, for a caller keeping its own ledger. */
  chargedMicroUsd: number;
  network: string;
  from: Hex;
  digest: Hex;
}

/**
 * Probe, sign, retry.
 *
 * ONE attempt, never an automatic retry. A nonce is single-use, so a retry
 * needs a fresh authorization — and if the first one did settle, retrying pays
 * twice for one answer. The caller decides, with the digest and nonce in hand
 * to reconcile against.
 */
export async function payWithNear(opts: {
  url: string;
  body?: unknown;
  /** The derived EVM address for this NEAR account + path. */
  from: Hex;
  sign: HashSigner;
  fetchImpl?: typeof globalThis.fetch;
  now?: number;
}): Promise<PayResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.body ?? {}),
  };

  const probe = await doFetch(opts.url, init);
  if (probe.status !== 402) {
    // Not a priced resource, or already free. Hand back what it said rather
    // than inventing a payment for something nobody asked to be paid for.
    return {
      status: probe.status,
      body: await probe.json().catch(() => null),
      chargedMicroUsd: 0,
      network: '',
      from: opts.from,
      digest: '0x' as Hex,
    };
  }

  const challenge = (await probe.json().catch(() => ({}))) as Challenge;
  const accept = selectAccept(challenge);
  if (!accept) {
    const offered = (challenge.accepts ?? []).map((a) => `${a.network}/${a.scheme}`).join(', ') || 'none';
    throw new Error(
      `No option this payer can sign. Chain Signatures produces EIP-712 ECDSA, so an EVM "exact" option is required; the resource offered: ${offered}.`,
    );
  }

  const auth = buildAuthorization(accept, opts.from, opts.now);
  const digest = authorizationDigest(accept, auth);
  const signature = toSignature(await opts.sign(digest));

  const paid = await doFetch(opts.url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), 'X-PAYMENT': paymentHeader(accept, auth, signature) },
  });

  return {
    status: paid.status,
    body: await paid.json().catch(() => null),
    chargedMicroUsd: paid.ok ? Number(accept.maxAmountRequired) : 0,
    network: accept.network,
    from: opts.from,
    digest,
  };
}

/* ───────────────────────── address derivation ─────────────────────────
 *
 * Which EVM address does a NEAR account control?
 *
 * Chain Signatures derives it deterministically and OFFLINE: the MPC network
 * publishes one root public key, and each (account, path) pair shifts it by a
 * scalar derived from those two strings. No RPC, no gas, no account needed —
 * so a caller can know its own address, and anyone can check it, before any
 * money moves.
 *
 *   epsilon      = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" +
 *                           accountId + "," + path)
 *   P_child      = P_root + epsilon·G
 *   address      = last 20 bytes of keccak256(P_child without its 0x04 tag)
 *
 * Implemented here rather than by importing chainsig.js, whose published
 * bundle also drags in bitcoinjs-lib, the @cosmjs suite, @mysten/sui, xrpl,
 * the Aptos SDK and @solana/web3.js — tens of megabytes of chains this
 * package never touches, inside an MCP server people install with npx. The
 * two primitives needed are declared dependencies and the result is checked
 * against chainsig.js's own output in the tests.
 *
 * Note sha3_256, NOT keccak256: they differ only in padding, which makes a
 * wrong one silently produce a valid-looking address for a key nobody holds.
 */

/** MPC root public keys, SEC1 uncompressed. From chainsig.js constants. */
const ROOT_PUBLIC_KEY_NAJ = {
  mainnet: 'secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya',
  testnet: 'secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3',
} as const;

/** The signer contract, for the caller that has to name it in a function call. */
export const SIGNER_CONTRACT = {
  mainnet: 'v1.signer',
  testnet: 'v1.signer-prod.testnet',
} as const;

export type NearNetwork = keyof typeof ROOT_PUBLIC_KEY_NAJ;

/**
 * The EVM address a NEAR account controls on a given path.
 *
 * The path is a plain string and any value works, so one account has an
 * unlimited supply of addresses. Reuse the SAME path to reuse an address —
 * changing it silently produces a different, unfunded one.
 */
export async function deriveEvmAddress(
  accountId: string,
  path: string,
  network: NearNetwork = 'mainnet',
): Promise<Hex> {
  const [{ sha3_256 }, { secp256k1 }, { base58 }, { getAddress, keccak256 }] = await Promise.all([
    import('@noble/hashes/sha3.js'),
    import('@noble/curves/secp256k1.js'),
    import('@scure/base'),
    import('viem'),
  ]);

  // najToUncompressedPubKeySEC1: drop the "secp256k1:" prefix, base58-decode
  // the 64-byte x||y, and re-tag it as an uncompressed SEC1 point.
  const raw = base58.decode(ROOT_PUBLIC_KEY_NAJ[network].split(':')[1]);
  // @noble/curves renamed ProjectivePoint -> Point in 2.x. Reading only one
  // name throws "cannot read properties of undefined" on the other major,
  // which reads like a broken install rather than a version difference.
  const c = secp256k1 as unknown as { Point?: PointCtor; ProjectivePoint?: PointCtor };
  const Point = c.Point ?? c.ProjectivePoint;
  if (!Point) throw new Error('@noble/curves exposes neither Point nor ProjectivePoint on secp256k1.');
  const root = Point.fromHex(`04${bytesToHex(raw)}`);

  const epsilon = BigInt(`0x${bytesToHex(sha3_256(`near-mpc-recovery v0.1.0 epsilon derivation:${accountId},${path}`))}`);
  const child = root.add(Point.BASE.multiply(epsilon));

  // keccak256 of x||y — the 0x04 tag is NOT part of the hashed input.
  // toHex(false) = uncompressed, i.e. 04||x||y. Drop the 04 tag before
  // hashing: it is a SEC1 encoding marker, not part of the key material.
  const xy = child.toHex(false).slice(2);
  return getAddress(`0x${keccak256(`0x${xy}`).slice(-40)}`) as Hex;
}

interface PointCtor {
  fromHex(hex: string): PointLike;
  BASE: PointLike;
}
interface PointLike {
  add(other: PointLike): PointLike;
  multiply(n: bigint): PointLike;
  toHex(compressed: boolean): string;
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
