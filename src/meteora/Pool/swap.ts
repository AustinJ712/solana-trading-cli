import { PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import BN from "bn.js";
import { fetchDynamicAmmPool } from "./fetch-pool";
import { connection, wallet, jito_fee } from "../../helpers/config";
import { getSPLTokenBalance } from "../../helpers/check_balance";
import { jito_executeAndConfirm } from "../../transactions/jito_tips_tx_executor";

/**
 * Performs a swap in a given Meteora dynamic-amm pool,
 * either "buy" (use SOL) or "sell" (sell your token).
 *
 * @param side "buy" or "sell"
 * @param tokenAddress The mint address of the token
 * @param buyAmountInSOL If side is "buy", how many SOL to spend
 * @param sellPercentage If side is "sell", how many % to sell
 */
export async function swap(
  side: "buy" | "sell",
  tokenAddress: string,
  buyAmountInSOL = 0.1,
  sellPercentage = 100
) {
  // 1) fetch the dynamic amm pool
  const dynamicPool = await fetchDynamicAmmPool(tokenAddress);
  const poolInfo = dynamicPool.poolInfo;

  // Print initial pool state
  console.log(
    'tokenA %s Amount: %s',
    dynamicPool.tokenAMint.address,
    poolInfo.tokenAAmount.toNumber() / Math.pow(10, dynamicPool.tokenAMint.decimals)
  );
  console.log(
    'tokenB %s Amount: %s',
    dynamicPool.tokenBMint.address,
    poolInfo.tokenBAmount.toNumber() / Math.pow(10, dynamicPool.tokenBMint.decimals)
  );

  let swapAmountLamports: BN;
  let swapInToken, swapOutToken;

  // Determine swap direction and tokens
  const isTokenAWsol = dynamicPool.tokenAMint.address.toString() === "So11111111111111111111111111111111111111112";
  if (side === "buy") {
    // For buy, we're using SOL to buy the other token
    swapInToken = isTokenAWsol ? dynamicPool.tokenAMint : dynamicPool.tokenBMint;
    swapOutToken = isTokenAWsol ? dynamicPool.tokenBMint : dynamicPool.tokenAMint;
    swapAmountLamports = new BN(Math.floor(buyAmountInSOL * 1e9));
  } else {
    // For sell, we're selling the token for SOL
    swapInToken = isTokenAWsol ? dynamicPool.tokenBMint : dynamicPool.tokenAMint;
    swapOutToken = isTokenAWsol ? dynamicPool.tokenAMint : dynamicPool.tokenBMint;
    // Calculate sell amount based on balance
    const balance = await getSPLTokenBalance(connection, new PublicKey(swapInToken.address), wallet.publicKey);
    const toSell = balance * (sellPercentage / 100);
    swapAmountLamports = new BN(toSell * 10 ** swapInToken.decimals);
  }

  // Get swap quote with 1% slippage
  const swapQuote = dynamicPool.getSwapQuote(
    new PublicKey(swapInToken.address),
    swapAmountLamports,
    100
  );

  console.log(
    'Swap In %s, Amount %s',
    swapInToken.address,
    swapQuote.swapInAmount.toNumber() / Math.pow(10, swapInToken.decimals)
  );
  console.log(
    'Swap Out %s, Amount %s',
    swapOutToken.address,
    swapQuote.swapOutAmount.toNumber() / Math.pow(10, swapOutToken.decimals)
  );
  console.log('Price Impact: %s', swapQuote.priceImpact);

  // Execute swap
  const swapTx = await dynamicPool.swap(
    wallet.publicKey,
    new PublicKey(swapInToken.address),
    swapAmountLamports,
    swapQuote.minSwapOutAmount
  );

  // Build and send transaction
  const recentBlockhash = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: recentBlockhash.blockhash,
    instructions: swapTx.instructions
  }).compileToV0Message();
  
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet]);

  // Send via Jito
  const result = await jito_executeAndConfirm(transaction, wallet, recentBlockhash, jito_fee);
  if (result.confirmed) {
    console.log(`Swap success: https://solscan.io/tx/${result.signature}`);
  } else {
    console.error("Swap failed or not confirmed");
  }
}
