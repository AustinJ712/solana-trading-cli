import { loadEnv } from "../utils/load-env";
import WebSocket from "ws";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { BN } from "@project-serum/anchor";
import { createAndSendV0Tx } from "./execute-txns";
import { connection } from "../helpers/config";
import { BloxrouteProvider } from "../bloxroute/bloxroute";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";
import {
  createFreezeAccountInstruction,
  createThawAccountInstruction,
} from "@solana/spl-token";
import { TransactionNotification } from "./helius-websocket-types";

// Suppose your program ID for dynamic amm
export const DYNAMIC_AMM_PROGRAM_ID = new PublicKey(
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"
);

// config:
const freezeKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.FREEZE_PRIVATE_KEY!)
);
const sniperKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.SWAP_PRIVATE_KEY!)
);

const swapAmountInSol = 0.1;
const minLiquidityInSol = 2;

let ws: WebSocket | null = null;

export function meteoraFreezeSnipe() {
  ws = new WebSocket(
    `wss://atlas-${process.env.NETWORK}.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  );

  function sendRequest(ws: WebSocket) {
    const request = {
      jsonrpc: "2.0",
      id: 999,
      method: "transactionSubscribe",
      params: [
        {
          accountInclude: [DYNAMIC_AMM_PROGRAM_ID.toBase58()],
          failed: false,
        },
        {
          commitment: "confirmed",
          encoding: "jsonParsed",
          transactionDetails: "full",
          showRewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    };
    ws.send(JSON.stringify(request));
  }

  ws.on("open", function open() {
    console.log("Freeze snipe listening on Helius...");
    if (ws) sendRequest(ws);
  });

  ws.on("message", parsePoolCreationTx);

  ws.on("error", function error(err) {
    console.error("WS error:", err);
  });

  ws.on("close", function close() {
    console.log("WS closed. Reconnect in 5s.");
    setTimeout(() => {
      if (ws) sendRequest(ws);
    }, 5000);
  });

  console.log(`Freeze sniping as: ${sniperKeypair.publicKey.toBase58()}`);
}

async function parsePoolCreationTx(data: WebSocket.Data) {
  const messageStr = data.toString("utf8");
  try {
    const messageObj = JSON.parse(messageStr) as TransactionNotification;
    if (!messageObj.params?.result) {
      return;
    }

    const { signature, transaction } = messageObj.params.result;
    if (transaction.meta.err) {
      // transaction failed, ignore
      return;
    }
    // check if it includes an "init pool" from the dynamic amm
    const ixList = transaction.transaction.message.instructions.filter((ix) => {
      return ix.programId === DYNAMIC_AMM_PROGRAM_ID.toBase58() &&
             checkCreatePoolInstruction(ix.data);
    });

    if (ixList.length === 0) return;

    // For demonstration, assume new pool is the second account:
    const newPoolPubkey = new PublicKey(
      transaction.transaction.message.accountKeys[1].pubkey
    );

    console.log(
      `🚀 Found new pool creation: ${signature}, pool = ${newPoolPubkey.toBase58()}`
    );

    // process
    await freezeSnipe(newPoolPubkey.toBase58(), swapAmountInSol, sniperKeypair);
  } catch (e) {
    console.error("parsePoolCreationTx error:", e);
  }
}

export async function freezeSnipe(
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

    console.log(`✅ Freeze snipe successful for pool: ${poolAddress}`);
  } catch (err) {
    console.error("freezeSnipe error:", err);
  }
}

function checkCreatePoolInstruction(base58data: string): boolean {
  // decode the raw data if needed to check for "createPool" variant
  // for now, we just return true
  return true;
}

// If you want to run directly:
if (require.main === module) {
  loadEnv();
  meteoraFreezeSnipe();

  process.on("SIGINT", () => {
    console.log("Caught interrupt signal, closing ws...");
    if (ws) ws.close();
    process.exit();
  });
}
