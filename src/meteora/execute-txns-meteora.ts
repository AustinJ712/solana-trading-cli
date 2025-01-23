// File: /Users/austin/Documents/GitHub/sol-sniper/meteora/execute-txns-meteora.ts

import {
    Connection,
    PublicKey,
    SendOptions,
    Signer,
    Transaction,
    TransactionInstruction,
    SystemProgram,
    ComputeBudgetProgram,
    VersionedTransaction,
    LAMPORTS_PER_SOL,
  } from '@solana/web3.js';
  
  import {
    getAccount,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    createCloseAccountInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    Account,
    TokenAccountNotFoundError,
    TokenInvalidAccountOwnerError,
    TokenInvalidMintError,
    TokenInvalidOwnerError,
  } from '@solana/spl-token';
  
  import BN from 'bn.js';
  
  /**
   * We add the BlockhashWithExpiryBlockHeight type here so that code importing from
   * "meteora/execute-txns-meteora" can reference it (matching usage from the Jito bundle).
   */
  export type BlockhashWithExpiryBlockHeight = Readonly<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  
  // Configuration for transaction sending in the Meteora environment
  export const METEORA_CONFIG = {
    rpcCommitment: 'confirmed' as const,
    maxRetries: 5,
    simulateTransactions: false,
    minComputeUnits: 200_000,
    minPriorityFee: 1_000, // in microLamports
  };
  
  // Singleton instance of the staked connection
  let stakedConnection: Connection | null = null;
  
  /**
   * Returns a staked Helius connection if available, otherwise falls back to the provided connection
   */
  export function getStakedConnection(fallbackConnection: Connection): Connection {
    const mainnet = process.env.NETWORK === 'mainnet';
    if (!stakedConnection && mainnet) {
      stakedConnection = new Connection(
        `https://staked.helius-rpc.com?api-key=${process.env.HELIUS_API_KEY}`,
        METEORA_CONFIG.rpcCommitment
      );
    }

    return stakedConnection ?? fallbackConnection;
  }
  
  /**
   * Sends a Transaction or VersionedTransaction with retries. If `confirm` is true,
   * it will wait for confirmation. This is the "normal" sending logic (non-Jito).
   */
  export async function sendTransactionWithRetries(
    connection: Connection,
    tx: Transaction | VersionedTransaction,
    signers: Signer[],
    confirm = true,
    options: SendOptions = {}
  ): Promise<string> {
    // Use staked connection if available
    const stakedConn = getStakedConnection(connection);

    if (tx instanceof Transaction) {
      tx.sign(...signers);
    } else {
      tx.sign(signers);
    }
  
    const rawTx = tx.serialize();
    let lastErr: any = null;
  
    for (let attempt = 1; attempt <= METEORA_CONFIG.maxRetries; attempt++) {
      try {
        const txSig = await stakedConn.sendRawTransaction(rawTx, {
          skipPreflight: false,
          maxRetries: 3,
          preflightCommitment: METEORA_CONFIG.rpcCommitment,
          ...options,
        });
  
        if (confirm) {
          const latestBlockhash = await stakedConn.getLatestBlockhash(
            METEORA_CONFIG.rpcCommitment
          );
          const confirmRes = await stakedConn.confirmTransaction(
            {
              signature: txSig,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            METEORA_CONFIG.rpcCommitment
          );
          if (confirmRes.value.err) {
            throw new Error(
              `Transaction ${txSig} failed => ${JSON.stringify(confirmRes.value.err)}`
            );
          }
          console.log(`✅ Transaction confirmed => ${txSig}`);
        } else {
          console.log(`✈️ Transaction sent (not confirmed). Sig = ${txSig}`);
        }
  
        return txSig;
      } catch (err) {
        lastErr = err;
        console.warn(`sendTransaction attempt #${attempt} failed =>`, err);
      }
    }
  
    throw new Error(
      `Failed after ${METEORA_CONFIG.maxRetries} attempts. Last error => ${lastErr}`
    );
  }
  
  /**
   * Optionally adds a ComputeBudgetProgram instruction for limiting or prioritizing compute.
   */
  export function addComputeBudgetInstructions(
    instructions: TransactionInstruction[],
    computeUnits = 200_000
  ) {
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits });
    instructions.unshift(cuIx);
  }
  
  /**
   * Creates the instructions to wrap SOL in a WSOL ATA. 
   * We must deposit both `rentExemption` + the desired lamports for the user's actual usage.
   */
  export async function createWrapSolInstructions(
    connection: Connection,
    userPubkey: PublicKey,
    wsolAta: PublicKey,
    userLamportsNeeded: number
  ): Promise<TransactionInstruction[]> {
    const stakedConn = getStakedConnection(connection);
    const rentExemption = await stakedConn.getMinimumBalanceForRentExemption(165);
    const totalLamports = rentExemption + userLamportsNeeded;
  
    const ix1 = SystemProgram.transfer({
      fromPubkey: userPubkey,
      toPubkey: wsolAta,
      lamports: totalLamports,
    });
  
    const ix2 = createSyncNativeInstruction(wsolAta);
  
    return [ix1, ix2];
  }
  
  /**
   * Create and send a normal (non-Jito) transaction. 
   * Typically used for utility or if not using Jito. 
   */
  export async function createAndSendMeteoraTx(
    connection: Connection,
    instructions: TransactionInstruction[],
    signers: Signer[],
    confirm = true,
    addComputeBudget = true
  ): Promise<string> {
    const stakedConn = getStakedConnection(connection);

    if (addComputeBudget) {
      addComputeBudgetInstructions(instructions);
    }
  
    const blockhashObj = await stakedConn.getLatestBlockhash(METEORA_CONFIG.rpcCommitment);
  
    const tx = new Transaction({
      feePayer: signers[0].publicKey,
      blockhash: blockhashObj.blockhash,
      lastValidBlockHeight: blockhashObj.lastValidBlockHeight,
    });
  
    tx.add(...instructions);
  
    return sendTransactionWithRetries(stakedConn, tx, signers, confirm);
  }
  
  /**
   * Gets (or creates) an associated token account for a given mint & owner,
   * returning the on-chain 'Account' data from spl-token.
   */
  export async function getOrCreateMeteoraAta(
    connection: Connection,
    payer: Signer,
    mint: PublicKey,
    owner: PublicKey
  ): Promise<Account> {
    const stakedConn = getStakedConnection(connection);
    const associatedToken = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  
    let account: Account | undefined;
    try {
      account = await getAccount(stakedConn, associatedToken, 'confirmed', TOKEN_PROGRAM_ID);
    } catch (error) {
      if (
        error instanceof TokenAccountNotFoundError ||
        error instanceof TokenInvalidAccountOwnerError
      ) {
        // Create the associated token account
        const ix = createAssociatedTokenAccountInstruction(
          payer.publicKey,
          associatedToken,
          owner,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        await createAndSendMeteoraTx(stakedConn, [ix], [payer], true);
        account = await getAccount(stakedConn, associatedToken, 'confirmed');
      } else {
        throw error;
      }
    }
  
    if (!account) {
      throw new Error(`Cannot get or create ATA for => ${mint.toBase58()}`);
    }
    if (!account.mint.equals(mint)) throw new TokenInvalidMintError();
    if (!account.owner.equals(owner)) throw new TokenInvalidOwnerError();
  
    return account;
  }
  
  /**
   * Creates an instruction to close a wrapped SOL account, effectively unwrapping.
   */
  export function createUnwrapSolInstruction(
    wsolAta: PublicKey,
    userPubkey: PublicKey
  ): TransactionInstruction {
    return createCloseAccountInstruction(
      wsolAta,
      userPubkey,
      userPubkey
    );
  }
  