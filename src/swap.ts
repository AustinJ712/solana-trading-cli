import { PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import BN from "bn.js";
import { connection, wallet, jito_fee } from "./helpers/config";
import { jito_executeAndConfirm } from "./jito_tips_tx_executor";
import DLMM from "@meteora-ag/dlmm";
import { logger } from "./logger";

/**
 * Performs a swap operation in a DLMM pool.
 * @param tokenAddress The token address to swap for
 * @param poolAddress The pool address where the swap will occur
 * @param amountIn The amount of input token (in SOL or USDC) to be used for buying
 * @param userWallet The keypair to use for the transaction
 * @param isUsdc Whether to use USDC (true) or SOL (false) as input token
 */
export async function flexSwap(
  tokenAddress: string,
  poolAddress: string,
  amountIn: number,
  userWallet: any,
  isUsdc: boolean = false
) {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const WSOL = 'So11111111111111111111111111111111111111112';
  
  logger.debug(`[flexSwap] Starting swap with params:
    Token Address: ${tokenAddress}
    Pool Address: ${poolAddress}
    Amount In: ${amountIn}
    Is USDC: ${isUsdc}
    User Wallet: ${userWallet.publicKey.toBase58()}`);

  try {
    // Connect directly to the pool using its address
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
    logger.debug(`[flexSwap] Successfully connected to pool. Token X: ${dlmmPool.tokenX.publicKey.toBase58()}, Token Y: ${dlmmPool.tokenY.publicKey.toBase58()}`);
    
    // Setup tokens for swap
    const inputTokenAddr = isUsdc ? USDC : WSOL;
    let inToken: PublicKey, outToken: PublicKey, swapYtoX: boolean;
    
    // Determine swap direction based on known token addresses
    if (dlmmPool.tokenY.publicKey.toBase58() === inputTokenAddr) {
      inToken = dlmmPool.tokenY.publicKey;
      outToken = dlmmPool.tokenX.publicKey;
      swapYtoX = true;
    } else {
      inToken = dlmmPool.tokenX.publicKey;
      outToken = dlmmPool.tokenY.publicKey;
      swapYtoX = false;
    }

    logger.debug(`[flexSwap] Swap direction determined:
      Input Token: ${inToken.toBase58()}
      Output Token: ${outToken.toBase58()}
      Swap Y to X: ${swapYtoX}`);

    // Convert amount based on input token decimals
    const decimals = isUsdc ? 6 : 9;
    const swapAmount = new BN(amountIn * 10 ** decimals);
    logger.debug(`[flexSwap] Amount converted to raw value: ${swapAmount.toString()}`);

    // If using USDC, verify the user has a token account and sufficient balance
    if (isUsdc) {
      try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userWallet.publicKey, { mint: new PublicKey(USDC) });
        if (tokenAccounts.value.length === 0) {
          throw new Error("No USDC token account found for wallet");
        }
        
        const usdcAccount = tokenAccounts.value[0];
        const balance = Number(usdcAccount.account.data.parsed.info.tokenAmount.amount);
        const requiredAmount = swapAmount.toNumber();
        
        logger.debug(`[flexSwap] USDC Account check:
          Account: ${usdcAccount.pubkey.toBase58()}
          Balance: ${balance}
          Required: ${requiredAmount}`);
        
        if (balance < requiredAmount) {
          throw new Error(`Insufficient USDC balance. Have ${balance}, need ${requiredAmount}`);
        }
      } catch (err) {
        logger.error(`[flexSwap] USDC account verification failed: ${err}`);
        throw err;
      }
    }

    // Get quote and execute swap
    logger.debug(`[flexSwap] Getting bin arrays for swap...`);
    const binArrays = await dlmmPool.getBinArrayForSwap(swapYtoX);
    logger.debug(`[flexSwap] Retrieved ${binArrays.length} bin arrays`);

    logger.debug(`[flexSwap] Getting swap quote...`);
    const swapQuote = await dlmmPool.swapQuote(
      swapAmount,
      swapYtoX,
      new BN(10),
      binArrays
    );
    logger.debug(`[flexSwap] Swap quote received:
      Min Out Amount: ${swapQuote.minOutAmount.toString()}
      Bin Arrays: ${swapQuote.binArraysPubkey.length} arrays`);

    logger.debug(`[flexSwap] Building swap transaction...`);
    const swapTx = await dlmmPool.swap({
      inToken,
      binArraysPubkey: swapQuote.binArraysPubkey,
      inAmount: swapAmount,
      lbPair: dlmmPool.pubkey,
      user: userWallet.publicKey,
      minOutAmount: swapQuote.minOutAmount,
      outToken,
    });
    logger.debug(`[flexSwap] Swap transaction built with ${swapTx.instructions.length} instructions`);

    // Execute transaction
    try {
      const recentBlockhash = await connection.getLatestBlockhash();
      const messageV0 = new TransactionMessage({
        payerKey: userWallet.publicKey,
        recentBlockhash: recentBlockhash.blockhash,
        instructions: [...swapTx.instructions],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([userWallet]);
      
      logger.debug(`[flexSwap] Executing transaction...`);
      const res = await jito_executeAndConfirm(
        transaction,
        userWallet,
        recentBlockhash,
        jito_fee
      );

      if (res.confirmed) {
        logger.info(`[flexSwap] Transaction confirmed! Signature: ${res.signature}`);
        console.log(`🚀 https://solscan.io/tx/${res.signature}`);
        return res.signature;
      } else {
        logger.error(`[flexSwap] Transaction was not confirmed. Response: ${JSON.stringify(res)}`);
        throw new Error("Transaction was not confirmed");
      }
    } catch (error: any) {
      logger.error(`[flexSwap] Transaction execution failed: ${error}`);
      if (error.logs) {
        logger.error(`[flexSwap] Transaction logs:\n${error.logs.join('\n')}`);
      }
      throw error;
    }
  } catch (error: any) {
    logger.error(`[flexSwap] Swap failed: ${error}`);
    throw error;
  }
}