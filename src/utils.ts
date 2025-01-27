/**
 * This file provides utility functions for transaction processing and instruction handling.
 * Key functionalities include:
 * - Decompiling Solana transactions into instructions
 * - Generating instruction sighashes for program identification
 * - Processing both legacy and versioned transaction formats
 *
 * Source (Rust): src/utils.rs
 */

import {
    PublicKey,
    TransactionInstruction,
    MessageV0,
    VersionedMessage,
    VersionedTransactionResponse,
    CompiledInstruction as Web3CompiledInstruction,
  } from '@solana/web3.js';
  import { SniperError, SniperErrorVariant } from './error';
  import { createHash } from 'crypto';
  
  /**
   * Define a minimal interface to represent the "legacy" message format
   * so we can unify logic. This is NOT exported by @solana/web3.js but
   * we'll replicate the structure from Rust's approach.
   */
  interface LegacyMessageCompat {
    accountKeys: PublicKey[];
    instructions: {
      programIdIndex: number;
      accounts: number[];
      data: Uint8Array;
    }[];
    // You could also define header, recentBlockhash, etc. if needed
  }
  
  /**
   * Decompiles a Solana transaction into its constituent instructions and account keys.
   *
   * @param tx The transaction data from an RPC subscription or normal getTransaction
   * @returns A tuple (instructions, involvedKeys)
   */
  export function decompileInstructions(
    tx: VersionedTransactionResponse
  ): [TransactionInstruction[], PublicKey[]] {
    if (!tx.transaction) {
      return [[], []];
    }
  
    // The type VersionedTransactionResponse has a "version" field within `transaction.message`.
    const messageAny = tx.transaction.message as any;
  
    // If it's a VersionedMessage
    if (typeof messageAny.version === 'number') {
      // v0 is messageAny.version === 0
      return handleVersionedMessage(messageAny as VersionedMessage);
    } else {
      // Otherwise, treat it as "legacy"
      return handleLegacyMessage(messageAny as LegacyMessageCompat, tx.meta?.innerInstructions || []);
    }
  }
  
  /**
   * Generates an 8-byte sighash for a given instruction name.
   * In Rust: used a simple hash on "global:{name}" and took first 8 bytes.
   *
   * @param name The name of the instruction
   * @returns A Uint8Array of length 8
   */
  export function sighash(name: string): Uint8Array {
    const preimage = `global:${name}`;
    const hash = createHash('sha256').update(preimage).digest();
    return hash.subarray(0, 8); // first 8 bytes
  }
  
  /**
   * Handle a Versioned (v0) message. In Rust code, we used VersionedMessage::V0.
   */
  function handleVersionedMessage(
    versioned: VersionedMessage
  ): [TransactionInstruction[], PublicKey[]] {
    const instructionsWithMetadata: TransactionInstruction[] = [];
    const keys: PublicKey[] = [...versioned.staticAccountKeys];
  
    // For each compiled instruction, build a TransactionInstruction
    versioned.compiledInstructions.forEach((compiledIx) => {
      const programId = versioned.staticAccountKeys[compiledIx.programIdIndex];
      const accounts = compiledIx.accountKeyIndexes.map((accIndex) => ({
        pubkey: versioned.staticAccountKeys[accIndex],
        isSigner: false,
        isWritable: false,
      }));
  
      instructionsWithMetadata.push(
        new TransactionInstruction({
          programId,
          keys: accounts,
          data: typeof compiledIx.data === 'string' 
            ? Buffer.from(compiledIx.data, 'base64')
            : Buffer.from(compiledIx.data),
        })
      );
    });
  
    return [instructionsWithMetadata, keys];
  }
  
  /**
   * Handle a legacy message, which we faked with our `LegacyMessageCompat`.
   */
  function handleLegacyMessage(
    legacy: LegacyMessageCompat,
    inner: Array<{
      index: number;
      instructions: Web3CompiledInstruction[];
    }>
  ): [TransactionInstruction[], PublicKey[]] {
    const instructionsWithMetadata: TransactionInstruction[] = [];
  
    legacy.instructions.forEach((compiledIx, ixIndex) => {
      const programId = legacy.accountKeys[compiledIx.programIdIndex];
      const accounts = compiledIx.accounts.map((accIndex) => ({
        pubkey: legacy.accountKeys[accIndex],
        isSigner: false,
        isWritable: false,
      }));
  
      instructionsWithMetadata.push(
        new TransactionInstruction({
          programId,
          keys: accounts,
          data: typeof compiledIx.data === 'string' 
            ? Buffer.from(compiledIx.data, 'base64')
            : Buffer.from(compiledIx.data),
        })
      );
  
      // Add possible inner instructions
      const matchedInner = inner.find((i) => i.index === ixIndex);
      if (matchedInner) {
        matchedInner.instructions.forEach((innerIx) => {
          const innerProgramId = legacy.accountKeys[innerIx.programIdIndex];
          const innerAccounts = innerIx.accounts.map((accIdx) => ({
            pubkey: legacy.accountKeys[accIdx],
            isSigner: false,
            isWritable: false,
          }));
  
          instructionsWithMetadata.push(
            new TransactionInstruction({
              programId: innerProgramId,
              keys: innerAccounts,
              data: typeof innerIx.data === 'string'
                ? Buffer.from(innerIx.data, 'base64')
                : Buffer.from(innerIx.data),
            })
          );
        });
      }
    });
  
    return [instructionsWithMetadata, legacy.accountKeys];
  }
  