import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { BN } from "@project-serum/anchor";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";
import { connection } from "../helpers/config";
import { createAndSendV0Tx } from "./execute-txns";

export async function snipeBundle(
  poolAddress: string,
  buyAmountInSOL: number,
  sniperKeypair: Keypair
) {
  try {
    const dynamicPool = await DynamicAmm.create(connection, new PublicKey(poolAddress));
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
    console.log('Virtual Price: %s', poolInfo.virtualPrice);

    // Determine swap direction (we want to swap SOL for token)
    const isTokenAWsol = dynamicPool.tokenAMint.address.toString() === "So11111111111111111111111111111111111111112";
    const swapInToken = isTokenAWsol ? dynamicPool.tokenAMint : dynamicPool.tokenBMint;
    const swapOutToken = isTokenAWsol ? dynamicPool.tokenBMint : dynamicPool.tokenAMint;

    // Calculate swap amount
    const buyLamports = new BN(buyAmountInSOL * LAMPORTS_PER_SOL);

    // Get swap quote with 1% slippage
    const swapQuote = dynamicPool.getSwapQuote(
      new PublicKey(swapInToken.address),
      buyLamports,
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
      sniperKeypair.publicKey,
      new PublicKey(swapInToken.address),
      buyLamports,
      swapQuote.minSwapOutAmount
    );

    // Send transaction
    await createAndSendV0Tx({
      connection,
      ix: swapTx.instructions,
      signers: [sniperKeypair],
      computeUnits: 200_000,
      fixedPriorityFee: true,
      minPriorityFee: 1_000_000,
    });

    console.log(`✅ Bundle snipe successful for pool: ${poolAddress}`);
  } catch (err) {
    console.error("snipeBundle error:", err);
  }
} 