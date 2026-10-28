/**
 * The two ways a NEAR account signs a payment (src/near.ts builds it):
 *
 *   direct     the agent's NEAR account asks v1.signer itself; the Base address
 *              is derived from that account.
 *   allowance  the agent's key may only call an agent-allowance contract
 *              (github.com/Gliana-Labs/gliana-near-x402/contract), which holds the
 *              Base address, rebuilds the digest from the terms and signs only
 *              within the owner's policy (payee list, per-payment and daily caps,
 *              one-hour validity). A leaked agent key is worth one day's budget.
 *
 * Loaded only when GLIANA_NEAR_KEY_FILE is set, so the @near-js packages cost a
 * wallet or balance user nothing at startup.
 */
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { rsvFromMpc, signArgs, SIGN_DEPOSIT, SIGN_GAS, SIGNER_CONTRACT, type Authorization, type HashSigner, type MpcSignature, type NearNetwork } from './near.js';

export type NearKey = { account_id: string; private_key: string };

function accountOf(key: NearKey, network: NearNetwork) {
  // FastNEAR, not rpc.<network>.near.org: 0.1-0.3 s a call against 3.1-3.7 s (measured 2026-10-29).
  const provider = new JsonRpcProvider({ url: process.env.GLIANA_NEAR_RPC_URL?.trim() || `https://rpc.${network}.fastnear.com` });
  return { provider, account: new Account(key.account_id, provider, new KeyPairSigner(KeyPair.fromString(key.private_key as `ed25519:${string}`))) };
}

function checked(result: unknown): MpcSignature {
  const r = result as MpcSignature | null;
  if (!r?.big_r?.affine_point || !r?.s?.scalar) throw new Error('The MPC returned no signature. Nothing was paid; try again.');
  return r;
}

export function directSigner(key: NearKey, path: string, network: NearNetwork): HashSigner {
  const { account } = accountOf(key, network);
  return async (digest) =>
    rsvFromMpc(checked(await account.callFunction({ contractId: SIGNER_CONTRACT[network], methodName: 'sign', args: signArgs(digest, path), gas: SIGN_GAS, deposit: SIGN_DEPOSIT })));
}

const termsOf = (a: Authorization) => ({ to: a.to, value: String(a.value), valid_after: String(a.validAfter), valid_before: String(a.validBefore), nonce: a.nonce });

export function allowanceSigner(key: NearKey, contractId: string, network: NearNetwork): HashSigner {
  const { provider, account } = accountOf(key, network);
  return async (digest, auth) => {
    // The contract's own digest must equal ours, or the signature would be for a different payment.
    const theirs = String(await provider.callFunction(contractId, 'preview_digest', termsOf(auth)));
    if (theirs.toLowerCase() !== digest.toLowerCase()) throw new Error(`${contractId} builds a different digest than this client; not signing.`);
    // The policy as a free view first: a refusal in ~0.2 s with nothing sent, instead of a
    // failed transaction (11.6 s on mainnet). `pay` still enforces every rule on chain.
    const why = (await provider.callFunction(contractId, 'check', { agent: key.account_id, to: auth.to, value: String(auth.value), valid_after: String(auth.validAfter), valid_before: String(auth.validBefore) }).catch(() => null)) as string | null;
    if (why) throw new Error(`Refused by the allowance ${contractId}: ${why}. Nothing was sent.`);
    try {
      return rsvFromMpc(checked(await account.callFunction({ contractId, methodName: 'pay', args: termsOf(auth), gas: SIGN_GAS, deposit: SIGN_DEPOSIT })));
    } catch (err) {
      // A policy refusal is the contract's own panic message: hand that over, not a stack.
      const why = /Smart contract panicked: ([^"\\n]+)/.exec(String((err as Error)?.message ?? err))?.[1];
      throw new Error(why ? `Refused by the allowance ${contractId}: ${why}.` : String((err as Error)?.message ?? err));
    }
  };
}
