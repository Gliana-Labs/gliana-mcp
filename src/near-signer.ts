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
 *              A payment that's unusual waits for the owner: nothing is signed until they approve.
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

type Held = { status: string; signature: string | null };
/** How long a call waits for the owner, in seconds. MCP clients have their own limits, so it's settable. */
const holdWaitS = () => Number(process.env.GLIANA_NEAR_HOLD_WAIT_S) || 240;

/**
 * Waits for the owner's answer to a held payment. The signature comes from the contract, once they approve.
 * If they don't answer in time, nothing was signed or paid, and the agent has to say so rather than retry on its own.
 */
export async function waitForOwner(read: () => Promise<Held | null>, id: string, contractId: string, until: number, now = Date.now, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<MpcSignature> {
  while (now() < until) {
    const h = await read();
    if (h?.status === 'rejected') throw new Error(`The owner rejected payment ${id} on ${contractId}. Nothing was paid.`);
    if (h?.status === 'signed' && h.signature) return JSON.parse(h.signature) as MpcSignature;
    await sleep(3000);
  }
  throw new Error(`Payment ${id} is waiting for the owner of ${contractId}, who hasn't approved it yet. Nothing was paid. Ask them to look at https://gliana-labs.github.io/gliana-near-x402/?contract=${contractId}`);
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
    // "held: ..." isn't a refusal: the contract keeps it for the owner.
    if (why && !why.startsWith('held:')) throw new Error(`Refused by the allowance ${contractId}: ${why}. Nothing was sent.`);
    try {
      const answer = (await account.callFunction({ contractId, methodName: 'pay', args: termsOf(auth), gas: SIGN_GAS, deposit: SIGN_DEPOSIT })) as (MpcSignature & { held?: string; refused?: string }) | null;
      if (answer?.refused) throw new Error(`Smart contract panicked: ${answer.refused}`);
      if (answer?.held) {
        const id = answer.held;
        const until = Math.min(Date.now() + holdWaitS() * 1000, Number(auth.validBefore) * 1000);
        return rsvFromMpc(await waitForOwner(() => provider.callFunction(contractId, 'get_held', { id }) as Promise<Held | null>, id, contractId, until));
      }
      return rsvFromMpc(checked(answer));
    } catch (err) {
      // A policy refusal is the contract's own panic message: hand that over, not a stack.
      const why = /Smart contract panicked: ([^"\\n]+)/.exec(String((err as Error)?.message ?? err))?.[1];
      throw new Error(why ? `Refused by the allowance ${contractId}: ${why}.` : String((err as Error)?.message ?? err));
    }
  };
}
