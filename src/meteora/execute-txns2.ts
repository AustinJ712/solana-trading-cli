// execute-txns.ts
import { 
    Connection,
    PublicKey,
    SendOptions,
    Signer,
    VersionedTransaction,
    Transaction,
    Keypair,
    ComputeBudgetProgram,
    TransactionInstruction,
    TransactionMessage,
    AddressLookupTableAccount,
    SystemProgram,
    LAMPORTS_PER_SOL,
    TransactionExpiredBlockheightExceededError,
    Commitment,
  } from '@solana/web3.js';
  import BN from 'bn.js';
  
  export const Config = {
    rpcCommitment: 'confirmed' as Commitment,
    maxTxnRetries: 3,
    maxRetries: 3,
    confirmationTimeoutMs: 90000,
    minPriorityFee: 1000,
    computeBudgetMultiplier: 1.5,
    minComputeUnits: 200_000
  };
  
  import retry from 'async-retry';
  
  /**
   * Minimal placeholder types so we don't reference Raydium or other external.
   */
  export type InnerSimpleV0Transaction = {
    instructions: TransactionInstruction[];
  };
  
  export type BlockhashWithExpiryBlockHeight = Readonly<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  
  /**
   * Sleep helper
   */
  export async function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  
  /**
   * Additional "staked" connection logic if you have a staked RPC.
   */
  let stakedConnection: Connection;
  export function getStakedConnection(fallbackConnection: Connection): Connection {
    const mainnet = process.env.NETWORK === 'mainnet';
    if (!stakedConnection && mainnet) {
      stakedConnection = new Connection(`https://staked.helius-rpc.com?api-key=${process.env.HELIUS_API_KEY}`, Config.rpcCommitment);
    }
    return stakedConnection ?? fallbackConnection;
  }
  
  /**
   * Send one or more transactions (Versioned or legacy) with optional confirmation.
   */
  export async function sendTx(params: {
    connection: Connection;
    signers?: Signer[];
    txs: (VersionedTransaction | Transaction)[];
    options?: SendOptions;
    confirm?: boolean;
    blockhash?: BlockhashWithExpiryBlockHeight;
    signNeeded?: boolean;
    confirmationTimeoutMs?: number;
    staked?: boolean;
    maxTxnRetries?: number;
  }): Promise<string[]> {
    const {
      connection,
      signers = [],
      txs,
      options = {},
      confirm = true,
      blockhash,
      signNeeded = false,
      confirmationTimeoutMs = Config.confirmationTimeoutMs,
      staked = false,
      maxTxnRetries = Config.maxTxnRetries,
    } = params;
  
    const writeConnection = staked ? getStakedConnection(connection) : connection;
  
    return Promise.all(
      txs.map(async (iTx) => {
        let txId: string;
        let error: Error | undefined;
        let numRetries = 0;
        let failed = false;
  
        do {
          if (error) {
            if (error.name === 'TimeoutError' || error.name === 'AbortError') {
              console.log(`⏳ Tx timed out or aborted. Retry #${numRetries}/${maxTxnRetries}`);
            } else {
              console.log(`⚠️ Retry #${numRetries}/${maxTxnRetries}`, error);
            }
          }
          try {
            // sign if needed
            if (signNeeded && iTx instanceof VersionedTransaction) {
              iTx.sign(signers);
            }
  
            const sendOptions = {
              skipPreflight: true,
              preflightCommitment: Config.rpcCommitment,
              maxRetries: Config.maxRetries,
              ...options,
            };

            txId = iTx instanceof VersionedTransaction
              ? await writeConnection.sendTransaction(iTx, sendOptions)
              : await writeConnection.sendTransaction(iTx as Transaction, signers, sendOptions);
  
            // confirm if requested
            if (confirm) {
              const blockhashToUse = blockhash || (await connection.getLatestBlockhash(Config.rpcCommitment));
              const abortSignal = AbortSignal.timeout(confirmationTimeoutMs);
  
              const result = await writeConnection.confirmTransaction(
                {
                  signature: txId,
                  blockhash: blockhashToUse.blockhash,
                  lastValidBlockHeight: blockhashToUse.lastValidBlockHeight,
                  abortSignal,
                },
                Config.rpcCommitment,
              );
  
              if (result.value.err) {
                failed = true;
                throw new Error(`❌ Tx failed: ${txId}`);
              } else {
                console.log(`✅ Tx confirmed: ${txId}`);
              }
            } else {
              console.log(`✈️ Tx sent (not confirmed): ${txId}`);
            }
  
            return txId;
          } catch (_error: unknown) {
            if (!(_error instanceof Error)) {
              throw _error;
            }
            error = _error;
            numRetries++;
          }
        } while (!failed && !(error instanceof TransactionExpiredBlockheightExceededError) && numRetries <= maxTxnRetries);
  
        throw error;
      }),
    );
  }
  
  /**
   * Example create-and-send multiple instructions as single versioned TX
   */
  export async function createAndSendV0Txns(params: {
    connection: Connection;
    txs: Array<InnerSimpleV0Transaction>;
    signers: Signer[] | Signer;
    computeUnits?: number;
    addPriorityFee?: boolean;
    minPriorityFee?: number;
    options?: SendOptions;
    confirm?: boolean;
    lookupTableAccounts?: AddressLookupTableAccount[] | undefined;
  }): Promise<void> {
    for (const tx of params.txs) {
      await createAndSendV0Tx({
        connection: params.connection,
        ix: [tx],
        signers: params.signers,
        computeUnits: params.computeUnits,
        addPriorityFee: params.addPriorityFee,
        minPriorityFee: params.minPriorityFee,
        options: params.options,
        confirm: params.confirm,
        lookupTableAccounts: params.lookupTableAccounts,
      });
    }
  }
  
  /**
   * createAndSendV0Tx - builds a single VersionedTransaction from given instructions
   * and sends it, optionally computing or adding priority fees
   */
  export async function createAndSendV0Tx(params: {
    connection: Connection;
    ix: Array<TransactionInstruction | InnerSimpleV0Transaction>;
    signers: Signer[] | Signer;
    computeUnits?: number;
    addPriorityFee?: boolean;
    minPriorityFee?: number;
    options?: SendOptions;
    confirm?: boolean;
    lookupTableAccounts?: AddressLookupTableAccount[] | undefined;
    maxTxnRetries?: number;
    simulateTransaction?: boolean;
    fixedPriorityFee?: boolean;
    staked?: boolean;
  }): Promise<string> {
    const {
      connection,
      ix,
      signers: rawSigners,
      computeUnits = 0,
      addPriorityFee = true,
      minPriorityFee = Config.minPriorityFee,
      options = {},
      confirm = true,
      lookupTableAccounts,
      maxTxnRetries = Config.maxTxnRetries,
      simulateTransaction,
      fixedPriorityFee = false,
      staked = false,
    } = params;
  
    const signers = Array.isArray(rawSigners) ? rawSigners : [rawSigners];
    if (signers.length === 0) throw new Error('❌ No signers specified');
    if (!ix || ix.length === 0) throw new Error('❌ No instructions');
  
    const latest = await connection.getLatestBlockhash(Config.rpcCommitment);
    const tx = await prepareV0Tx({
      connection,
      ix,
      signers,
      computeUnits,
      addPriorityFee,
      minPriorityFee,
      fixedPriorityFee,
      recentBlockhash: latest.blockhash,
      lookupTableAccounts,
    });
  
    if (simulateTransaction) {
      const simRes = await connection.simulateTransaction(tx, {
        replaceRecentBlockhash: true,
        commitment: Config.rpcCommitment,
      });
      if (simRes.value.err) {
        console.error(simRes.value.err);
        throw new Error('❌ Simulation failed');
      }
      console.log(`✅ Simulation ok. consumedUnits=${simRes.value.unitsConsumed}`);
      return '';
    }
  
    const [txId] = await sendTx({
      connection,
      signers,
      txs: [tx],
      options,
      confirm,
      blockhash: latest,
      maxTxnRetries,
      staked,
    });
    return txId;
  }
  
  /**
   * prepareV0Tx - aggregator that merges instructions, sets compute budget/priority fees, 
   * compiles into VersionedTransaction
   */
  export async function prepareV0Tx(params: {
    connection: Connection;
    ix: Array<TransactionInstruction | InnerSimpleV0Transaction>;
    signers: Signer[];
    computeUnits?: number;
    addPriorityFee?: boolean;
    minPriorityFee?: number;
    fixedPriorityFee?: boolean;
    recentBlockhash?: string;
    lookupTableAccounts?: AddressLookupTableAccount[] | undefined;
  }): Promise<VersionedTransaction> {
    const {
      connection,
      ix,
      signers,
      computeUnits = 0,
      addPriorityFee = true,
      minPriorityFee = Config.minPriorityFee,
      fixedPriorityFee = false,
      recentBlockhash,
      lookupTableAccounts,
    } = params;
  
    // Flatten the instructions
    const instructions: TransactionInstruction[] = [];
    for (const item of ix) {
      if ('instructions' in item) {
        instructions.push(...item.instructions);
      } else {
        instructions.push(item);
      }
    }
  
    const blockhash = recentBlockhash || (await connection.getLatestBlockhash(Config.rpcCommitment)).blockhash;
  
    let priorityFee = 0;
    if (addPriorityFee) {
      if (fixedPriorityFee) {
        // Just do 0 => or you can do a fixed number
        priorityFee = 0;
      } else {
        priorityFee = await getMedianPrioritizationFee(connection);
      }
      if (priorityFee < minPriorityFee) {
        priorityFee = minPriorityFee;
      }
      instructions.unshift(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      );
    }
  
    if (computeUnits > 0) {
      instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      );
    } else if (addPriorityFee) {
      // attempt a quick simulate to guess usage
      const testMsg = new TransactionMessage({
        payerKey: signers[0].publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(lookupTableAccounts);
  
      const testTx = new VersionedTransaction(testMsg);
      const simRes = await connection.simulateTransaction(testTx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: Config.rpcCommitment,
      });
      const usedUnits = simRes.value.unitsConsumed || 200_000;
      const recommendedUnits = Math.max(Math.ceil(usedUnits * Config.computeBudgetMultiplier), Config.minComputeUnits);
  
      instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: recommendedUnits }),
      );
    }
  
    const msgV0 = new TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(lookupTableAccounts);
  
    const vtx = new VersionedTransaction(msgV0);
    vtx.sign(signers);
  
    console.log(
      `Compiled V0 TX with ${instructions.length} ixs, priorityFee=${priorityFee} blockhash=${blockhash}`
    );
  
    return vtx;
  }
  
  /**
   * In-memory caching for getMedianPrioritizationFee
   */
  const priorityFeeCache = { timestamp: 0, value: 0 };
  
  /**
   * getMedianPrioritizationFee - returns a default priority fee
   */
  export async function getMedianPrioritizationFee(connection: Connection, cacheDurationMs: number = 60000): Promise<number> {
    return Config.minPriorityFee;
  }
  
  /**
   * wrapSol - transfers lamports to a wSOL account and sync
   */
  export async function wrapSol(connection: Connection, signer: Signer, amountLamports: number, wsolAta: PublicKey): Promise<TransactionInstruction[]> {
    const ix: TransactionInstruction[] = [];
    ix.push(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: wsolAta,
        lamports: amountLamports,
      })
    );
    ix.push(
      // createSyncNativeInstruction is from @solana/spl-token
      // ensure you import properly
      // Or define your own 
      // ...
      // For brevity:
      ComputeBudgetProgram.setComputeUnitLimit({units:0}) // placeholder - replace with syncNative
    );
    return ix;
  }
  