import { PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import BN from "bn.js";
import { fetchDLMMPool } from "./fetch-pool";
import { connection, wallet, jito_fee } from "../../helpers/config";
import { getSPLTokenBalance } from "../../helpers/check_balance";
import { jito_executeAndConfirm } from "../../transactions/jito_tips_tx_executor";
import { getOrCreateAssociatedTokenAccount, NATIVE_MINT } from "@solana/spl-token";

/**
 * Performs a swap operation in a DLMM pool.
 * @param tokenAddress The address of the token to be swapped.
 * @param amountIn The amount of input token (in SOL or USDC) to be used for buying.
 * @param isUsdc Whether to use USDC (true) or SOL (false) as input token.
 */
export async function flexSwap(
  tokenAddress: string,
  amountIn: number,
  isUsdc: boolean = false
) {
  const dlmmPool = await fetchDLMMPool(tokenAddress);
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const WSOL = 'So11111111111111111111111111111111111111112';

  let inToken: PublicKey, outToken: PublicKey, swapAmount: BN;
  const inputTokenAddr = isUsdc ? USDC : WSOL;

  // Determine swap direction and tokens
  let swapYtoX = true; // Default to Y->X swap
  if (dlmmPool.tokenY.publicKey.toBase58() === inputTokenAddr) {
    inToken = dlmmPool.tokenY.publicKey;
    outToken = dlmmPool.tokenX.publicKey;
    swapYtoX = true; // Swapping from Y to X
  } else {
    inToken = dlmmPool.tokenX.publicKey;
    outToken = dlmmPool.tokenY.publicKey;
    swapYtoX = false; // Swapping from X to Y
  }

  // Convert amount based on input token decimals
  const decimals = isUsdc ? 6 : 9;
  swapAmount = new BN(amountIn * 10 ** decimals);

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
    user: wallet.publicKey,
    minOutAmount: swapQuote.minOutAmount,
    outToken,
  });

  // Execute transaction
  try {
    const recentBlockhash = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: recentBlockhash.blockhash,
      instructions: [...swapTx.instructions],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);
    const res = await jito_executeAndConfirm(
      transaction,
      wallet,
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