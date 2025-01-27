/**
 * This module provides service-level functionality for the application,
 * particularly focusing on transaction handling and RPC communication.
 *
 * Source: src/services/mod.rs (Rust).
 */

import { SniperError, SniperErrorVariant } from '../error';
import { ENVIRONMENTS, RPC_CONNECTION } from '../config';
import {
  VersionedTransaction,
  Connection,
  Signer
} from '@solana/web3.js';

/**
 * Attempts to send a transaction to multiple Jito RPC endpoints,
 * returning the first successful signature or throwing an error
 * if all fail.
 */
export async function sendTransaction(
  tx: VersionedTransaction,
  signers: Signer[]
): Promise<string> {
  // Simulate first
  const sim = await RPC_CONNECTION.simulateTransaction(tx);
  // We do not handle sim result here

  // Ensure transaction is signed
  if (!tx.signatures || tx.signatures.length === 0) {
    tx.sign(signers);
  }

  const rpcUrls = ENVIRONMENTS.jito_rpcs.split(',');
  let lastErr = '';

  // Fire in parallel
  const rawTx = tx.serialize();
  const results = await Promise.allSettled(
    rpcUrls.map(async (url) => {
      const conn = new Connection(url, 'confirmed');
      const sig = await conn.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 3
      });
      return sig;
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      return r.value;
    } else {
      lastErr = (r.reason || '').toString();
    }
  }

  throw new SniperError(SniperErrorVariant.TransactionFailed, lastErr);
}
