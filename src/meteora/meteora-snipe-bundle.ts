import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { BN } from "bn.js";
import { createAndSendV0Tx } from "./execute-txns";
import { connection } from "../helpers/config";
import { BloxrouteProvider } from "../bloxroute/bloxroute";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";

const sniperKeypair = Keypair.fromSecretKey(bs58.decode(process.env.SWAP_PRIVATE_KEY!));

/**
 * Snipe multiple Meteora pools in one go. If aggregator = “bloxroute”,
 * we do a single “submitBatchTxs” call. Otherwise, we just do them individually.
 */
export async function snipeBundleMeteora(
  connection: Connection,
  poolAddresses: PublicKey[],
  amountsInSol: number[],
  aggregator: "bloxroute" | "none"
) {
  if (poolAddresses.length !== amountsInSol.length) {
    throw new Error("poolAddresses vs amountsInSol mismatch");
  }

  // Build instructions for each pool
  const bigIxArray: TransactionInstruction[][] = [];

  for (let i = 0; i < poolAddresses.length; i++) {
    try {
      const dynamicPool = await DynamicAmm.create(connection, poolAddresses[i]);
      const lamports = new BN(amountsInSol[i] * 1e9);

      const swapTx = await dynamicPool.swap(sniperKeypair.publicKey, dynamicPool.tokenBMint.address, lamports, new BN(0));
      bigIxArray.push(swapTx.instructions);
    } catch (e) {
      console.error(`Error building swap for pool ${poolAddresses[i].toBase58()}:`, e);
    }
  }

  if (bigIxArray.length === 0) {
    throw new Error("No valid instructions to send");
  }

  if (aggregator === "bloxroute") {
    // Combine them in a “batch”
    const authHeader = process.env.BLOXROUTE_AUTH_HEADER!;
    const baseUrl = process.env.BLOXROUTE_BASE_URL!;
    const blx = new BloxrouteProvider(authHeader, baseUrl);

    await blx.submitBatchTxs({
      ixs: bigIxArray,
      signers: bigIxArray.map(() => [sniperKeypair]),
      connection,
      computeUnits: 200_000,
      submitStrategy: "P_SUBMIT_ALL",
      useBundle: true,
      frontRunningProtection: false,
    });
    console.log("✅ BloXroute batch completed");
  } else {
    // do them individually
    for (let i = 0; i < bigIxArray.length; i++) {
      await createAndSendV0Tx({
        connection,
        ix: bigIxArray[i],
        signers: [sniperKeypair],
        computeUnits: 200_000,
        fixedPriorityFee: true,
        minPriorityFee: 1_000_000,
      });
    }
    console.log("✅ Single by single snipe done");
  }
}

// Example usage
if (require.main === module) {
  (async () => {
    const p1 = new PublicKey(process.env.EXAMPLE_POOL_1!);
    const p2 = new PublicKey(process.env.EXAMPLE_POOL_2!);
    await snipeBundleMeteora(connection, [p1, p2], [0.2, 0.15], "bloxroute");
  })().catch(console.error);
}
