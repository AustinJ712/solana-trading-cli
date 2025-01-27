import {
    BlockhashWithExpiryBlockHeight,
    Keypair,
    PublicKey,
    SystemProgram,
    Connection,
    TransactionMessage,
    VersionedTransaction,
  } from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";
import { connection } from "./helpers/config";
import { logger } from "./logger";

const jito_Validators = [
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
];

const endpoints = [
  "https://mainnet.block-engine.jito.wtf",
  "https://amsterdam.mainnet.block-engine.jito.wtf",
  "https://frankfurt.mainnet.block-engine.jito.wtf",
  "https://ny.mainnet.block-engine.jito.wtf",
  "https://tokyo.mainnet.block-engine.jito.wtf",
].map(url => `${url}/api/v1/bundles`);

// Cache endpoint latencies
let endpointLatencies: { [key: string]: number } = {};

/**
 * Check latency to an endpoint
 */
async function checkEndpointLatency(url: string): Promise<number> {
  const start = Date.now();
  try {
    await axios.get(url.replace('/api/v1/bundles', '/api/v1/health'), { 
      timeout: 3000 
    });
    return Date.now() - start;
  } catch (e) {
    return Infinity;
  }
}

/**
 * Get the fastest endpoints sorted by latency
 */
async function getFastestEndpoints(): Promise<string[]> {
  logger.debug(`[jito] Checking endpoint latencies...`);
  
  // Check all endpoints in parallel
  const latencies = await Promise.all(
    endpoints.map(async (url) => {
      const latency = await checkEndpointLatency(url);
      endpointLatencies[url] = latency;
      return { url, latency };
    })
  );

  // Sort by latency
  const sorted = latencies
    .filter(({ latency }) => latency !== Infinity)
    .sort((a, b) => a.latency - b.latency);

  logger.debug(`[jito] Endpoint latencies:${sorted.map(({ url, latency }) => 
    `\n  ${url}: ${latency}ms`).join('')}`);

  return sorted.map(({ url }) => url);
}

/**
 * Generates a random validator from the list of jito_Validators.
 * @returns {PublicKey} A new PublicKey representing the random validator.
 */
export async function getRandomValidator() {
  const res =
    jito_Validators[Math.floor(Math.random() * jito_Validators.length)];
  return new PublicKey(res);
}

/**
 * Executes and confirms a Jito transaction.
 * @param {Transaction} transaction - The transaction to be executed and confirmed.
 * @param {Account} payer - The payer account for the transaction.
 * @param {Blockhash} lastestBlockhash - The latest blockhash.
 * @param {number} jitofee - The fee for the Jito transaction.
 * @returns {Promise<{ confirmed: boolean, signature: string | null }>} - A promise that resolves to an object containing the confirmation status and the transaction signature.
 */
export async function jito_executeAndConfirm(
  transaction: any,
  payer: Keypair,
  lastestBlockhash: any,
  jitofee: any
) {
  logger.debug("[jito] Starting transaction execution...");
  
  // Get fastest endpoints first
  const fastEndpoints = await getFastestEndpoints();
  if (fastEndpoints.length === 0) {
    logger.error("[jito] No responsive endpoints found");
    return { confirmed: false, signature: null };
  }
  logger.debug(`[jito] Using ${fastEndpoints.length} fastest endpoints`);

  const jito_validator_wallet = await getRandomValidator();
  logger.debug(`[jito] Selected validator: ${jito_validator_wallet.toBase58()}`);

  try {
    // Get a fresh blockhash right before sending
    const freshBlockhash = await connection.getLatestBlockhash('confirmed');
    logger.debug(`[jito] Got fresh blockhash: ${freshBlockhash.blockhash}, valid until height ${freshBlockhash.lastValidBlockHeight}`);

    // Convert jitofee from SOL to lamports (1 SOL = 1e9 lamports)
    const fee = Math.floor(parseFloat(jitofee) * 1e9);
    logger.debug(`[jito] Fee: ${fee / 1e9} SOL (${fee} lamports)`);

    // Build fee transaction with fresh blockhash
    const jitoFee_message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: freshBlockhash.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: jito_validator_wallet,
          lamports: fee,
        }),
      ],
    }).compileToV0Message();

    const jitoFee_transaction = new VersionedTransaction(jitoFee_message);
    jitoFee_transaction.sign([payer]);
    const jitoTxSignature = bs58.encode(jitoFee_transaction.signatures[0]);
    
    logger.debug(`[jito] Fee transaction signature: ${jitoTxSignature}`);

    // Update main transaction's blockhash too
    transaction.message.recentBlockhash = freshBlockhash.blockhash;

    // Serialize transactions
    const serializedJitoFeeTransaction = bs58.encode(
      jitoFee_transaction.serialize()
    );
    const serializedTransaction = bs58.encode(transaction.serialize());
    const final_transaction = [
      serializedJitoFeeTransaction,
      serializedTransaction,
    ];

    // Try endpoints in order of latency
    logger.debug(`[jito] Sending bundle to fastest endpoints...`);
    let success = false;
    let lastError = null;

    for (const url of fastEndpoints) {
      try {
        const response = await axios.post(url, {
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [final_transaction],
        }, {
          timeout: 5000  // 5 second timeout per endpoint
        });

        if (response.data && !response.data.error) {
          success = true;
          logger.debug(`[jito] Bundle accepted by ${url}`);
          break;
        } else if (response.data.error) {
          lastError = response.data.error;
          logger.debug(`[jito] Bundle rejected by ${url}: ${JSON.stringify(response.data.error)}`);
        }
      } catch (e: any) {
        lastError = e;
        logger.debug(`[jito] Failed to send to ${url}: ${e.message}`);
        continue;
      }
    }

    if (success) {
      logger.debug(`[jito] Bundle accepted, confirming transaction...`);
      return await jito_confirm(jitoTxSignature, freshBlockhash);
    } else {
      logger.error(`[jito] No endpoints accepted the bundle. Last error: ${lastError}`);
      return { confirmed: false, signature: jitoTxSignature };
    }
  } catch (e: any) {
    logger.error(`[jito] Failed to execute transaction: ${e.message}`);
    return { confirmed: false, signature: null };
  }
}

/**
 * Confirms a Jito transaction.
 * @param {string} signature - The transaction signature.
 * @param {Blockhash} blockhash - The blockhash of the transaction.
 * @returns {Promise<{ confirmed: boolean, signature: string | null }>} - A promise that resolves to an object containing the confirmation status and the transaction signature.
 */
async function jito_confirm(signature: string, blockhash: BlockhashWithExpiryBlockHeight) {
  logger.debug(`[jito] Confirming transaction ${signature}...`);
  
  const MAX_RETRIES = 3;
  const INITIAL_BACKOFF_MS = 500;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        logger.debug(`[jito] Retry attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      const confirmation = await connection.confirmTransaction({
        signature,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight
      }, 'confirmed');

      if (confirmation.value.err) {
        logger.error(`[jito] Transaction failed on attempt ${attempt + 1}: ${JSON.stringify(confirmation.value.err)}`);
        if (attempt === MAX_RETRIES - 1) {
          return { confirmed: false, signature: null };
        }
        continue;
      }

      logger.debug(`[jito] Transaction confirmed successfully on attempt ${attempt + 1}`);
      return { confirmed: true, signature };
    } catch (e: any) {
      logger.error(`[jito] Confirmation failed on attempt ${attempt + 1}: ${e.message}`);
      if (attempt === MAX_RETRIES - 1) {
        return { confirmed: false, signature: null };
      }
      
      // If it's a block height exceeded error, no point in retrying
      if (e.message.includes('block height exceeded')) {
        logger.error('[jito] Block height exceeded, aborting retries');
        return { confirmed: false, signature: null };
      }
    }
  }

  logger.error(`[jito] All confirmation attempts failed`);
  return { confirmed: false, signature: null };
}