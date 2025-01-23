/**
 * o1-sniper.ts
 *
 * Listens via Helius websockets for new "Initialize LBPair" instructions from the Meteora DLMM
 * program. Two modes:
 *
 *  1) **Normal mode**: Checks if the new pool includes your TARGET_TOKEN_ADDRESS paired with USDC or SOL,
 *     and immediately executes a swap using your sniper wallet.
 *  2) **Test mode** (`--test`): Ignores the TARGET_TOKEN_ADDRESS. Instead, it buys whichever token
 *     is paired with USDC or SOL in the newly launched pool (the "unknown" token side).
 *
 * In both modes, a mandatory 0.01 SOL tip is sent to a randomly chosen Jito validator as part
 * of the bundle. This uses Jito's `sendBundle()` for a near-zero block snipe, integrates with
 * `execute-txns-meteora.ts` for wrapping SOL/creating ATAs, and references the official DLMM
 * SDK for the actual swap logic.
 *
 *   - jito/send-bundle.ts              => to send transactions as a Jito bundle
 *   - meteora/execute-txns-meteora.ts  => for creating ATA, wrap SOL if needed
 *   - meteora/Pool/fetch-pool.ts       => example fetchDLMMPool or DLMM.create
 *   - .env                             => environment variables
 */

import 'dotenv/config';
import WebSocket from 'ws';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';

import bs58 from 'bs58';
import BN from 'bn.js';

// Official DLMM (meteora-ag/dlmm) imports
import DLMM from '@meteora-ag/dlmm';

// Local code references (adjust paths as needed)
import { sendBundle } from '../jito/send-bundle';                // your actual path
import type { BlockhashWithExpiryBlockHeight } from './execute-txns-meteora';  // your local file
import {
  createWrapSolInstructions,
  getOrCreateMeteoraAta,
} from './execute-txns-meteora';

/** 
 * Parse CLI args to see if we're in --test mode.
 */
function parseCliArgs() {
  const args = process.argv.slice(2);
  return {
    isTestMode: args.includes('--test'),
  };
}

//////////////////////////////////////////////////////////////////////////////////////
// ENV + Config
//////////////////////////////////////////////////////////////////////////////////////

// Choose cluster from env, default to mainnet
const NETWORK_ENV = process.env.NETWORK || 'mainnet';  
const MAINNET_ENDPOINT = process.env.MAINNET_ENDPOINT || 'https://api.mainnet-beta.solana.com';  
const DEVNET_ENDPOINT  = process.env.DEVNET_ENDPOINT  || 'https://api.devnet.solana.com';  

// The cluster-specific RPC endpoint
const RPC_ENDPOINT = (NETWORK_ENV === 'devnet') ? DEVNET_ENDPOINT : MAINNET_ENDPOINT;

/**
 * IMPORTANT: 
 *   We must use the Helius "atlas" (or "geyser") aggregator WebSocket endpoint
 *   in order to use "transactionSubscribe" successfully. The standard 
 *   wss://mainnet.helius-rpc.com does NOT support it.
 */
const WS_ENDPOINT = 'wss://atlas-mainnet.helius-rpc.com/?api-key=e7a0fa4f-35a0-44b0-abcc-67b82875b2df';

// The sniper wallet that holds SOL or USDC to buy the target token
const SNIPER_PRIVATE_KEY_B58 = process.env.SWAP_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!SNIPER_PRIVATE_KEY_B58) {
  throw new Error('Missing SWAP_PRIVATE_KEY (or PRIVATE_KEY) in .env');
}
const SNIPER_KEYPAIR = Keypair.fromSecretKey(bs58.decode(SNIPER_PRIVATE_KEY_B58));

// The target token we want to buy on new pool creation (ignored in test mode)
const TARGET_TOKEN_ADDRESS = process.env.TARGET_TOKEN_ADDRESS;
if (!TARGET_TOKEN_ADDRESS) {
  throw new Error('No TARGET_TOKEN_ADDRESS in .env');
}
const TARGET_TOKEN_MINT = new PublicKey(TARGET_TOKEN_ADDRESS);

// Amount to spend if the pool side is USDC or SOL
const QUOTE_AMOUNT_USDC = parseFloat(process.env.QUOTE_AMOUNT_USDC || '5');   // e.g. 5 USDC
const QUOTE_AMOUNT_SOL  = parseFloat(process.env.QUOTE_AMOUNT_SOL  || '0.05'); // e.g. 0.05 SOL

// Slippage in BPS
const SNIPE_SLIPPAGE_BPS = parseInt(process.env.SNIPE_SLIPPAGE_BPS || '10000');

// Minimal approximate liquidity requirement in SOL
const MIN_LIQUIDITY_SOL = parseFloat(process.env.MIN_LIQUIDITY_SOL || '0.001');

// The LB CLMM (DLMM) program ID on mainnet
const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

// Standard USDC + WSOL Mints
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL_MINT  = new PublicKey('So11111111111111111111111111111111111111112');

// We always tip 0.01 SOL in the Jito bundle
const TIP_LAMPORTS = Math.floor(0.01 * LAMPORTS_PER_SOL);

// A few known Jito validator addresses from mainnet to pick from randomly
const JITO_VALIDATORS = [
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
];
function pickRandomJitoValidator(): PublicKey {
  const index = Math.floor(Math.random() * JITO_VALIDATORS.length);
  return new PublicKey(JITO_VALIDATORS[index]);
}

//////////////////////////////////////////////////////////////////////////////////////
// Minimal shape for Helius transaction objects
//////////////////////////////////////////////////////////////////////////////////////

interface HeliusTransaction {
  meta: {
    err: any;
    preTokenBalances?: any[];
    postTokenBalances?: any[];
    logMessages?: string[];
  };
  transaction: {
    message: {
      instructions: Array<{
        programId: string;
        data: string;
        accounts?: string[];
      }>;
    };
  };
  signature: string;
}

interface HeliusRealtimeMessage {
  jsonrpc: string;
  method: string;
  error?: {
    code: number;
    message: string;
  };
  params: {
    result: HeliusTransaction;
    subscription: number;
  };
  id?: string | number;
}

//////////////////////////////////////////////////////////////////////////////////////

export class O1DlmmSniper {
  private ws: WebSocket | null = null;
  private connection: Connection;
  private processedTxCount = 0;
  private processedPools: Set<string> = new Set();
  private isTestMode: boolean;

  constructor(
    private rpcUrl: string,
    private wsUrl: string,
    isTestMode: boolean
  ) {
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    this.isTestMode = isTestMode;
  }

  /**
   * Start the sniper: open WS subscription to the Helius aggregator, watch for 
   * "initialize LBPair" instructions from the DLMM program, parse the new pool 
   * address, check conditions, then do a Jito-based bundle swap.
   */
  public start() {
    console.log(`\n==== Meteora DLMM Pool Sniper ====\n`);
    console.log(`Environment: ${NETWORK_ENV}`);
    console.log(`RPC Endpoint: ${this.rpcUrl}`);
    console.log(`WebSocket Endpoint: ${this.wsUrl}`);
    console.log(`Sniper wallet: ${SNIPER_KEYPAIR.publicKey.toBase58()}`);
    console.log(`Test mode? ${this.isTestMode}`);

    if (!this.isTestMode) {
      console.log(`Target token (to buy): ${TARGET_TOKEN_MINT.toBase58()}`);
    } else {
      console.log(`(Test mode: ignoring TARGET_TOKEN_ADDRESS, just buy any new token with USDC/SOL side)`);
    }

    console.log(`USDC buy amount: ${QUOTE_AMOUNT_USDC}, SOL buy amount: ${QUOTE_AMOUNT_SOL}`);
    console.log(`Slippage (BPS): ${SNIPE_SLIPPAGE_BPS}`);
    console.log(`Min pool liquidity (approx SOL eq): ${MIN_LIQUIDITY_SOL}`);
    console.log(`Mandatory Jito tip: 0.01 SOL\n`);

    this.initWebSocket();
  }

  /**
   * Initialize the WebSocket connection to Helius aggregator (atlas).
   * We'll subscribe to any transaction referencing the DLMM program ID.
   */
  private initWebSocket() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('WebSocket connected to Helius aggregator. Subscribing to DLMM transactions...\n');

      const subscription = {
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [
          {
            accountInclude: [DLMM_PROGRAM_ID],
            failed: false,
          },
          {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
            transactionDetails: 'full'
          }
        ]
      };

      this.ws!.send(JSON.stringify(subscription));
      console.log('Subscription request sent. Waiting for messages...');
    });

    this.ws.on('message', async (data: any) => {
      try {
        const rawStr = data.toString();
        const msg = JSON.parse(rawStr) as HeliusRealtimeMessage;

        if (msg.error) {
          console.error('❌ Subscription error from Helius:', msg.error);
          return;
        }

        // Make sure we have params and result
        if (!msg.params || !msg.params.result) {
          // Not a transaction notify
          return;
        }

        // Safely access meta and check for errors
        const { transaction, meta } = msg.params.result;
        if (!transaction || !meta) {
          return;
        }

        this.processedTxCount++;
        if (this.processedTxCount % 20 === 0) {
          console.log(`Processed ${this.processedTxCount} referencing-DLMM txs so far...`);
        }

        // Now safely check meta.err
        if (meta.err) {
          // skip failed TXs if we don't care
          return;
        }

        // Check if there's an init instruction for LBPair
        const dlmmIx = transaction.message.instructions.find(ix => ix.programId === DLMM_PROGRAM_ID);
        if (!dlmmIx) {
          // not a LBPair init, skip
          return;
        }

        console.log(`\n🌟 Found a TX with LBPair init instruction!`);
        await this.handleNewPool(msg.params.result);

      } catch (err) {
        console.error('Error while parsing WS message =>', err);
      }
    });

    this.ws.on('close', () => {
      console.error('WebSocket closed. Will reconnect in 5s...');
      setTimeout(() => this.initWebSocket(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('WS error =>', err);
    });
  }

  /**
   * handleNewPool: parse the newly created LB pair address, create the DLMM instance,
   * check if it meets our buy conditions, then do the swap if so.
   */
  private async handleNewPool(txInfo: HeliusTransaction) {
    try {
      // Log raw transaction details
      console.log('\n------------------------------------');
      console.log(`New transaction referencing LBCLMM => Sig: ${txInfo.signature}`);

      // Print transaction logs if available
      if (txInfo.meta?.logMessages) {
        console.log('\nLog Messages:');
        for (const log of txInfo.meta.logMessages) {
          console.log('   ', log);
        }
      }

      // Print instruction details if available
      if (txInfo.transaction?.message?.instructions) {
        console.log('\nInstructions:');
        for (const ix of txInfo.transaction.message.instructions) {
          console.log('   Program:', ix.programId);
          console.log('   Data:', ix.data);
          if (ix.accounts) {
            console.log('   Accounts:', ix.accounts);
          }
          console.log('');
        }
      }

      // Print token balances if available
      if (txInfo.meta?.preTokenBalances || txInfo.meta?.postTokenBalances) {
        console.log('\nToken Balances:');
        console.log('Pre:', txInfo.meta.preTokenBalances);
        console.log('Post:', txInfo.meta.postTokenBalances);
      }

      console.log('\nTX Error:', txInfo.meta?.err ? txInfo.meta.err : 'None');
      console.log('------------------------------------\n');

      const lbPairPubkey = await this.findLbPairPubkey(txInfo);
      if (!lbPairPubkey) {
        console.log('[handleNewPool] Could not parse LB pair from TX logs/balances. Skipping...');
        return;
      }

      const poolAddrStr = lbPairPubkey.toBase58();
      if (this.processedPools.has(poolAddrStr)) {
        console.log(`[handleNewPool] LB pair ${poolAddrStr} already processed. Skipping...`);
        return;
      }
      // Mark as processed to avoid multiple attempts
      this.processedPools.add(poolAddrStr);

      console.log(`[handleNewPool] Attempting to load DLMM state for new LB Pair: ${poolAddrStr}...`);
      const dlmmPool = await DLMM.create(this.connection, lbPairPubkey, {
        cluster: NETWORK_ENV === 'mainnet' ? 'mainnet-beta' : 'devnet',
      });

      // Evaluate tokens, liquidity, etc.
      await this.evaluateAndSnipe(dlmmPool, poolAddrStr);
    } catch (err) {
      console.error('Error in handleNewPool =>', err);
    }
  }

  /**
   * Evaluate if the new pool meets our snipe conditions (test-mode or normal-mode).
   * If it does, call doSwapForPool(...) to do the Jito bundle swap.
   */
  private async evaluateAndSnipe(dlmmPool: any, poolAddrStr: string) {
    const xMint = dlmmPool.tokenX.publicKey;
    const yMint = dlmmPool.tokenY.publicKey;

    console.log(`[evaluateAndSnipe] Checking pool => ${poolAddrStr}`);
    console.log(`   tokenX: ${xMint.toBase58()} [raw: ${dlmmPool.tokenX.amount.toString()}]`);
    console.log(`   tokenY: ${yMint.toBase58()} [raw: ${dlmmPool.tokenY.amount.toString()}]`);

    // Approx liquidity check in SOL terms
    const humX = Number(dlmmPool.tokenX.amount.toString()) / (10 ** dlmmPool.tokenX.decimal);
    const humY = Number(dlmmPool.tokenY.amount.toString()) / (10 ** dlmmPool.tokenY.decimal);
    let solEq = 0;

    // approximate 1 USDC => 0.5 SOL
    if (xMint.equals(SOL_MINT))  solEq += humX;
    if (yMint.equals(SOL_MINT))  solEq += humY;
    if (xMint.equals(USDC_MINT)) solEq += humX * 0.5;
    if (yMint.equals(USDC_MINT)) solEq += humY * 0.5;

    console.log(`   approx liquidity in SOL eq => ${solEq.toFixed(4)}`);
    if (solEq < MIN_LIQUIDITY_SOL) {
      console.log('   => insufficient liquidity, skipping...');
      return;
    }

    // Distinguish test mode from normal mode
    if (this.isTestMode) {
      const hasUSDC = xMint.equals(USDC_MINT) || yMint.equals(USDC_MINT);
      const hasSOL  = xMint.equals(SOL_MINT)  || yMint.equals(SOL_MINT);

      if (!hasUSDC && !hasSOL) {
        console.log(`   [test-mode] no USDC or SOL => skip`);
        return;
      }

      console.log(`   [test-mode] Found a USDC/SOL side => let's snipe the other token`);
      await this.doSwapForPool(dlmmPool, true);

    } else {
      // normal mode => must have target token + (USDC or SOL)
      const hasTargetX = xMint.equals(TARGET_TOKEN_MINT);
      const hasTargetY = yMint.equals(TARGET_TOKEN_MINT);

      if (!hasTargetX && !hasTargetY) {
        console.log(`   [normal-mode] does not have target token => skip`);
        return;
      }

      // The other side must be USDC or SOL
      const otherMint = hasTargetX ? yMint : xMint;
      const isUsdcOrSol = otherMint.equals(USDC_MINT) || otherMint.equals(SOL_MINT);
      if (!isUsdcOrSol) {
        console.log(`   [normal-mode] other side is not USDC/SOL => skip`);
        return;
      }

      console.log(`   [normal-mode] Has target token + USDC/SOL => attempt snipe now...`);
      await this.doSwapForPool(dlmmPool, false);
    }
  }

  /**
   * Actually do the swap.
   * - If inTestMode => buy the "other token" from whichever side is USDC or SOL.
   * - If normal => buy the target token from whichever side is not target. 
   *
   * Also constructs a 0.01 SOL tip for a random Jito validator, then calls `sendBundle()`.
   */
  private async doSwapForPool(dlmmPool: any, inTestMode: boolean) {
    try {
      const xMint = dlmmPool.tokenX.publicKey;
      const yMint = dlmmPool.tokenY.publicKey;

      let inMint: PublicKey;
      let outMint: PublicKey;
      let lamportsNeeded = 0;

      if (inTestMode) {
        // If xMint is USDC or SOL => that's paying side
        // else yMint is paying side
        const xIsUsdcOrSol = xMint.equals(USDC_MINT) || xMint.equals(SOL_MINT);
        if (xIsUsdcOrSol) {
          inMint  = xMint;
          outMint = yMint;
        } else {
          inMint  = yMint;
          outMint = xMint;
        }
      } else {
        // normal mode => find which side is target, the other side is inMint
        const xIsTarget = xMint.equals(TARGET_TOKEN_MINT);
        if (xIsTarget) {
          inMint  = yMint; // must be USDC or SOL
          outMint = xMint; // target
        } else {
          inMint  = xMint; // must be USDC or SOL
          outMint = yMint; // target
        }
      }

      // how many lamports do we need?
      if (inMint.equals(SOL_MINT)) {
        lamportsNeeded = Math.floor(QUOTE_AMOUNT_SOL * LAMPORTS_PER_SOL);
        console.log(`   Paying with SOL => ${QUOTE_AMOUNT_SOL} => lamportsNeeded=${lamportsNeeded}`);
      } else if (inMint.equals(USDC_MINT)) {
        lamportsNeeded = Math.floor(QUOTE_AMOUNT_USDC * 1_000_000); 
        console.log(`   Paying with USDC => ${QUOTE_AMOUNT_USDC} => lamportsNeeded=${lamportsNeeded}`);
      } else {
        console.log(`   inMint is not USDC or SOL => ${inMint.toBase58()} => skip`);
        return;
      }

      // Build the swap quote
      const isSwapYtoX = dlmmPool.tokenY.publicKey.equals(inMint);
      const binArrays = await dlmmPool.getBinArrayForSwap(isSwapYtoX);
      const swapBN = new BN(lamportsNeeded);

      const swapQuote = dlmmPool.swapQuote(
        swapBN,
        isSwapYtoX,
        new BN(SNIPE_SLIPPAGE_BPS),
        binArrays
      );

      console.log(`   swapQuote => in:${swapQuote.consumedInAmount.toString()}, out:${swapQuote.outAmount.toString()}, priceImp:${swapQuote.priceImpact.toString()}%`);

      // If paying with SOL => wrap it
      let wsolAta: PublicKey | undefined;
      if (inMint.equals(SOL_MINT)) {
        const wsolAcct = await getOrCreateMeteoraAta(
          this.connection,
          SNIPER_KEYPAIR,
          SOL_MINT,
          SNIPER_KEYPAIR.publicKey
        );
        wsolAta = wsolAcct.address;
      }

      // create ATA for outMint if needed
      await getOrCreateMeteoraAta(
        this.connection,
        SNIPER_KEYPAIR,
        outMint,
        SNIPER_KEYPAIR.publicKey
      );

      // build the swap instructions
      const swapTx = await dlmmPool.swap({
        inToken: inMint,
        outToken: outMint,
        inAmount: swapQuote.consumedInAmount,
        minOutAmount: swapQuote.minOutAmount,
        lbPair: dlmmPool.pubkey,
        user: SNIPER_KEYPAIR.publicKey,
        binArraysPubkey: swapQuote.binArraysPubkey,
        ...(inMint.equals(SOL_MINT)
          ? (isSwapYtoX ? { userTokenY: wsolAta } : { userTokenX: wsolAta })
          : {}
        ),
      });

      const instructions: TransactionInstruction[] = [...swapTx.instructions];

      // If paying with SOL, we must deposit lamports to the WSOL ATA first
      if (inMint.equals(SOL_MINT) && wsolAta) {
        const wrapIxs = await createWrapSolInstructions(
          this.connection,
          SNIPER_KEYPAIR.publicKey,
          wsolAta,
          lamportsNeeded
        );
        instructions.unshift(...wrapIxs);
      }

      // Build versioned transaction for the swap
      const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
      const swapMessage = new TransactionMessage({
        payerKey: SNIPER_KEYPAIR.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message();
      const swapVtx = new VersionedTransaction(swapMessage);
      swapVtx.sign([SNIPER_KEYPAIR]);

      // Build tip transaction => 0.01 SOL to a random Jito validator
      const tipValidator = pickRandomJitoValidator();
      console.log(`   Tipping validator: ${tipValidator.toBase58()} => 0.01 SOL`);
      const tipIx = SystemProgram.transfer({
        fromPubkey: SNIPER_KEYPAIR.publicKey,
        toPubkey: tipValidator,
        lamports: TIP_LAMPORTS,
      });

      const tipMessage = new TransactionMessage({
        payerKey: SNIPER_KEYPAIR.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [tipIx],
      }).compileToV0Message();

      const tipVtx = new VersionedTransaction(tipMessage);
      tipVtx.sign([SNIPER_KEYPAIR]);

      // Send them together via Jito
      console.log('   => sending Jito bundle with tip + swap...');
      await sendBundle(
        SNIPER_KEYPAIR,
        this.connection,
        async (_blk: BlockhashWithExpiryBlockHeight, _tipAccount: PublicKey) => {
          return [tipVtx, swapVtx];
        },
        5,
        30000
      );

      console.log('   => Jito bundle sent. Await acceptance/rejection events.\n');

    } catch (err) {
      console.error('[doSwapForPool] Error =>', err);
    }
  }

  /**
   * (Placeholder) parse logs or postTokenBalances from txInfo to find the newly-created LB Pair address.
   * You must implement a real parser for production usage.
   */
  private async findLbPairPubkey(_txInfo: HeliusTransaction): Promise<PublicKey | null> {
    // TODO: implement real logic
    // For demonstration, returning null => no actual snipe occurs
    return null;
  }
}

// If invoked directly
if (require.main === module) {
  const { isTestMode } = parseCliArgs();
  const sniper = new O1DlmmSniper(RPC_ENDPOINT, WS_ENDPOINT, isTestMode);
  sniper.start();
  console.log('Press Ctrl+C to exit...');
}
