import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";
import { connection } from "../helpers/config";

/**
 * Example: get the approximate "price in SOL" for some token pool
 * by reading the current active bin. Real usage might differ,
 * or you might do direct formula reading from the pool states.
 */
export async function getCurrentPriceInSOL(tokenAddress: string): Promise<number> {
  const dynamicPool = await DynamicAmm.create(connection, new PublicKey(tokenAddress));

  // Get price by using a small amount quote (e.g. 1 SOL)
  const inAmount = new BN(1e9); // 1 SOL in lamports
  const slippageBps = 50; // 0.5% slippage
  const { minSwapOutAmount } = dynamicPool.getSwapQuote(
    dynamicPool.tokenBMint.address,
    inAmount,
    slippageBps
  );

  // Price = output amount / input amount
  return minSwapOutAmount.toNumber() / 1e9;
}

/**
 * If you want to do "price in USD" you presumably do:
 * (priceInSOL) * (some fetched "SOL in USD" from an oracle or aggregator)
 */
export async function getCurrentPriceInUSD(tokenAddress: string): Promise<number> {
  const priceInSOL = await getCurrentPriceInSOL(tokenAddress);
  // fetch a current SOL price from your aggregator (Jupiter, Switchboard, Pyth, etc.)
  const solPriceUsd = 20; // placeholder
  return priceInSOL * solPriceUsd;
}
