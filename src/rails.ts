import { evm } from 'mppx/client';
import { Assets } from 'mppx/evm';

/**
 * The Base (USDC) payment method.
 *
 * `currencies` is not optional in practice: the EVM charge client signs an
 * EIP-3009 authorization, which needs the token's EIP-712 domain (name +
 * version), and the gateway's challenge carries only the token address. Without
 * a known asset to look it up from, mppx throws "EVM authorization requires
 * token name and version" before signing — every Base payment from this server
 * failed that way until 0.8.2, which is why it is built here and tested.
 */
export function baseMethod(account: Parameters<typeof evm>[0]['account']) {
  return evm({ account, currencies: [Assets.base.USDC] });
}
