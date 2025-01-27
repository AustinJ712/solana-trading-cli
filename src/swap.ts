import { PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import BN from "bn.js";
import { connection, wallet, jito_fee } from "./helpers/config";
import { jito_executeAndConfirm } from "./jito_tips_tx_executor";
import DLMM from "@meteora-ag/dlmm";

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
  
  // Connect directly to the pool using its address
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  
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

  // Convert amount based on input token decimals
  const decimals = isUsdc ? 6 : 9;
  const swapAmount = new BN(amountIn * 10 ** decimals);

  // Get quote and execute swap
  const binArrays = await dlmmPool.getBinArrayForSwap(swapYtoX);
  const swapQuote = await dlmmPool.swapQuote(
    swapAmount,
    swapYtoX,
    new BN(10),
    binArrays
  );

  const swapTx = await dlmmPool.swap({
    inToken,
    binArraysPubkey: swapQuote.binArraysPubkey,
    inAmount: swapAmount,
    lbPair: dlmmPool.pubkey,
    user: userWallet.publicKey,
    minOutAmount: swapQuote.minOutAmount,
    outToken,
  });

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
    const res = await jito_executeAndConfirm(
      transaction,
      userWallet,
      recentBlockhash,
      jito_fee
    );

    if (res.confirmed) {
      console.log(`🚀 https://solscan.io/tx/${res.signature}`);
      return res.signature;
    }
  } catch (error) {
    console.error("Swap failed:", error);
    throw error;
  }
}