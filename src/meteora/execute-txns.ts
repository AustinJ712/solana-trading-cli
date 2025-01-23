/**
 * super-sniper-dynamicamm.ts
 *
 * Listens for new pools created by the Meteora DLMM (dynamic-liquidity market making) program
 * (on-chain subscription) AND periodically checks the dlmm-api (backup).
 * Immediately attempts to swap (buy) the non‐USDC/SOL side using either SOL or USDC,
 * reading from environment variables in .env.
 *
 * In this version, we snipe ANY new pool that has either (SomeToken - USDC) or (SomeToken - SOL).
 * No specific "target token" logic is used.
 */

import 'dotenv/config'; // For reading .env
import WebSocket from 'ws';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { BN } from 'bn.js';

// SPL helpers for ATA creation
import {
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
  createSyncNativeInstruction,
} from '@solana/spl-token';

// Official DLMM TS client
import DLMM from '@meteora-ag/dlmm';

// Your fetch-pool logic (adjust path as needed)
import {
  fetchAllPoolStats,
  fetchDLMMPool,
} from './Pool/fetch-pool';  // <--- adjust if needed

///////////////////////////////////////////////////////////////////////////////////
// ENV variables
///////////////////////////////////////////////////////////////////////////////////
const NETWORK_ENV = process.env.NETWORK || 'mainnet'; // 'mainnet' or 'devnet'

// If you want a direct Helius or other RPC, do so here
// Example mainnet Helius endpoint
const MAINNET_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=e7a0fa4f-35a0-44b0-abcc-67b82875b2df";
const DEVNET_ENDPOINT  = process.env.DEVNET_ENDPOINT  || 'https://api.devnet.solana.com';

const RPC_ENDPOINT =
  NETWORK_ENV === 'devnet' ? DEVNET_ENDPOINT : MAINNET_ENDPOINT;

// Use a WebSocket on the same cluster
const WS_MAINNET_ENDPOINT =
  process.env.WS_MAINNET_ENDPOINT || 'wss://mainnet.helius-rpc.com/?api-key=e7a0fa4f-35a0-44b0-abcc-67b82875b2df';

// This is your sniping keypair that holds SOL or USDC
const SNIPER_PRIVATE_KEY_B58 =
  process.env.SWAP_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!SNIPER_PRIVATE_KEY_B58) {
  throw new Error('No SWAP_PRIVATE_KEY or PRIVATE_KEY found in .env');
}
const SNIPER_KEYPAIR = Keypair.fromSecretKey(
  bs58.decode(SNIPER_PRIVATE_KEY_B58)
);

// We either force SOL if QUOTE_MINT=WSOL, or else prefer USDC
const FORCE_SOL = process.env.QUOTE_MINT === 'WSOL';

// The buy amounts in USDC and SOL respectively
const QUOTE_AMOUNT_USDC = parseFloat(process.env.QUOTE_AMOUNT_USDC || '5');
const QUOTE_AMOUNT_SOL = parseFloat(process.env.QUOTE_AMOUNT_SOL || '0.001');

// Slippage in BPS
const SNIPE_SLIPPAGE_BPS = parseInt(process.env.SNIPE_SLIPPAGE_BPS || '10000');

// Minimum liquidity threshold in "SOL equivalent"
const MIN_LIQUIDITY_SOL = parseFloat(
  process.env.MIN_LIQUIDITY_SOL || '0.001'
);

// USDC + SOL Mints
const USDC_MINT = new PublicKey(
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
);
const SOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112'
);

// The known DLMM Program ID for "InitializeLbPair"
const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

///////////////////////////////////////////////////////////////////////////////////
// Minimal shape of Helius realtime message
///////////////////////////////////////////////////////////////////////////////////
interface HeliusTransaction {
  meta: {
    err: any;
    postTokenBalances?: any[];
    preTokenBalances?: any[];
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
  params: {
    result: HeliusTransaction;
    subscription: number;
  };
  id?: string | number;
}

///////////////////////////////////////////////////////////////////////////////////

export class DlmmPoolSniper {
  private ws: WebSocket | null = null;
  private connection: Connection;
  private processedTxCount: number = 0;

  /**
   * We store the addresses of already-processed LB pairs so we don't snipe them again.
   */
  private processedPools: Set<string> = new Set();

  constructor(private rpcURL: string, private wsUrl: string) {
    // Use 'confirmed' or 'finalized'
    this.connection = new Connection(rpcURL, 'confirmed');
  }

  public start() {
    console.log(
      `🚀 Starting ANY-pool DLMM sniper on ${NETWORK_ENV}, using RPC: ${this.rpcURL}`
    );
    console.log(`Sniper wallet: ${SNIPER_KEYPAIR.publicKey.toBase58()}`);
    console.log(`WS endpoint: ${this.wsUrl}`);
    console.log(
      `Will swap with ${
        FORCE_SOL ? 'SOL' : 'USDC'
      } on new pools that contain USDC or SOL on one side`
    );
    console.log(
      `Quote amounts: ${QUOTE_AMOUNT_USDC} USDC / ${QUOTE_AMOUNT_SOL} SOL`
    );
    console.log(
      `Slippage BPS: ${SNIPE_SLIPPAGE_BPS}, min liquidity: ${MIN_LIQUIDITY_SOL}\n`
    );

    // 1) Start the WebSocket subscription for real-time "InitializeLbPair"
    this.initWebSocketSubscription();

    // 2) Start a periodic backup: fetch dlmm-api every 5 seconds
    this.startApiBackupInterval();
  }

  private initWebSocketSubscription() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('✅ WebSocket connected for dlmm sniper');
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
            transactionDetails: 'full',
          },
        ],
      };
      this.ws!.send(JSON.stringify(subscription));
      console.log(
        'Listening for new DLMM pool transactions... (on the same cluster you are using!)'
      );
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as HeliusRealtimeMessage;
        if (!msg.params || !msg.params.result) return;

        const { transaction, meta } = msg.params.result;
        if (meta.err) return; // skip failed
        this.processedTxCount++;
        if (this.processedTxCount % 50 === 0) {
          console.log(`Processed ${this.processedTxCount} dlmm TX so far...`);
        }

        // Identify some "InitializeLbPair" instruction
        const initPoolIx = transaction.message.instructions.find((ix) => {
          return ix.programId === DLMM_PROGRAM_ID;
        });
        if (!initPoolIx) return;

        await this.handleNewPool(msg.params.result);
      } catch (err) {
        console.error('WS message parse error', err);
      }
    });

    this.ws.on('close', () => {
      console.log('❌ WebSocket closed, reconnecting in 5s...');
      setTimeout(() => this.initWebSocketSubscription(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('⚠️ WebSocket error:', err);
    });
  }

  private startApiBackupInterval() {
    setInterval(async () => {
      try {
        // fetch from the dlmm-api *without* specifying a particular token => we want all pools
        const pools = await fetchAllPoolStats('');

        for (const poolInfo of pools) {
          const lbPairAddr = poolInfo.address;
          if (this.processedPools.has(lbPairAddr)) {
            continue;
          }
          console.log(
            `\n[API-Backup] Found new pool: ${poolInfo.name} => ${lbPairAddr}. Attempting to load...`
          );
          const dlmmPool = await fetchDLMMPool(lbPairAddr);

          await this.attemptSnipeDlmmPool(dlmmPool, lbPairAddr);
          this.processedPools.add(lbPairAddr);
        }
      } catch (err) {
        console.error('[API-Backup] Error:', err);
      }
    }, 5000); // poll every 5 seconds
  }

  private async handleNewPool(txInfo: HeliusTransaction) {
    try {
      const lbPairPubkey = await this.findLbPairPubkey(txInfo);
      if (!lbPairPubkey) {
        console.log('Could not find new LB pair address in TX logs. Skipping...');
        return;
      }
      if (this.processedPools.has(lbPairPubkey.toBase58())) {
        console.log(
          `LB pair ${lbPairPubkey.toBase58()} already processed. Skipping...`
        );
        return;
      }

      const dlmmPool = await DLMM.create(this.connection, lbPairPubkey, {
        cluster: NETWORK_ENV === 'mainnet' ? 'mainnet-beta' : 'devnet',
      });

      await this.attemptSnipeDlmmPool(dlmmPool, lbPairPubkey.toBase58());
      this.processedPools.add(lbPairPubkey.toBase58());
    } catch (err) {
      console.error('Error in handleNewPool:', err);
    }
  }

  private async findLbPairPubkey(_txInfo: HeliusTransaction): Promise<PublicKey | null> {
    // parse logs or postTokenBalances for the new lbPair
    // placeholder returning dummy
    return new PublicKey('11111111111111111111111111111111');
  }

  private async attemptSnipeDlmmPool(dlmmPool: any, poolAddr: string) {
    // We want to snipe ANY new pool that has either SOL or USDC on one side
    const { tokenX, tokenY } = dlmmPool;
    const hasUSDC =
      tokenX.publicKey.equals(USDC_MINT) || tokenY.publicKey.equals(USDC_MINT);
    const hasSOL =
      tokenX.publicKey.equals(SOL_MINT) || tokenY.publicKey.equals(SOL_MINT);

    if (!hasUSDC && !hasSOL) {
      console.log(
        `Pool ${poolAddr} does not have USDC or SOL on either side. Skipping snipe.`
      );
      return;
    }

    // check liquidity
    const humX =
      Number(dlmmPool.tokenX.amount.toString()) / 10 ** dlmmPool.tokenX.decimal;
    const humY =
      Number(dlmmPool.tokenY.amount.toString()) / 10 ** dlmmPool.tokenY.decimal;
    let solEq = 0;
    if (dlmmPool.tokenX.publicKey.equals(SOL_MINT)) {
      solEq += humX;
    }
    if (dlmmPool.tokenY.publicKey.equals(SOL_MINT)) {
      solEq += humY;
    }
    // approximate 1 USDC => 0.5 SOL
    if (dlmmPool.tokenX.publicKey.equals(USDC_MINT)) {
      solEq += humX * 0.5;
    }
    if (dlmmPool.tokenY.publicKey.equals(USDC_MINT)) {
      solEq += humY * 0.5;
    }

    if (solEq < MIN_LIQUIDITY_SOL) {
      console.log(
        `Pool ${poolAddr} => liquidity ~${solEq.toFixed(
          2
        )} SOL eq < min. Skipping snipe.`
      );
      return;
    }

    console.log(
      `\n🔫 Attempting snipe for pool ${poolAddr}, hasUSDC=${hasUSDC}, hasSOL=${hasSOL}`
    );
    const useSOL = FORCE_SOL || (!hasUSDC && hasSOL);
    await this.snipePool(dlmmPool, useSOL, poolAddr);
  }

  /**
   * We now do *one single transaction* that:
   *   - if using SOL, deposit rentExemption+tradeLamports into WSOL
   *   - run the DLMM swap instructions
   */
  private async snipePool(dlmmPool: any, useSOL: boolean, poolAddr?: string) {
    try {
      // figure out which side is (SOL or USDC)
      let inMint: PublicKey;
      let outMint: PublicKey;

      // We'll see if X is SOL/USDC
      const xIsSolOrUsdc =
        dlmmPool.tokenX.publicKey.equals(SOL_MINT) ||
        dlmmPool.tokenX.publicKey.equals(USDC_MINT);
      if (xIsSolOrUsdc) {
        inMint = dlmmPool.tokenX.publicKey;
        outMint = dlmmPool.tokenY.publicKey;
      } else {
        inMint = dlmmPool.tokenY.publicKey;
        outMint = dlmmPool.tokenX.publicKey;
      }

      const isInMintSOL = inMint.equals(SOL_MINT);
      const isInMintUSDC = inMint.equals(USDC_MINT);

      if (useSOL && !isInMintSOL) {
        console.log(
          `But the pool's "SOL" side is actually the other side. Let's invert...`
        );
        inMint = outMint;
        outMint = isInMintSOL
          ? dlmmPool.tokenX.publicKey
          : dlmmPool.tokenY.publicKey;
      } else if (!useSOL && !isInMintUSDC) {
        console.log(
          `But the pool's "USDC" side is actually the other side. Let's invert...`
        );
        inMint = outMint;
        outMint = isInMintUSDC
          ? dlmmPool.tokenX.publicKey
          : dlmmPool.tokenY.publicKey;
      }

      // The actual lamports we want to trade
      const swapLamports = useSOL
        ? Math.floor(QUOTE_AMOUNT_SOL * LAMPORTS_PER_SOL)
        : Math.floor(QUOTE_AMOUNT_USDC * 1_000_000); // USDC is 6 decimals

      console.log(`Debug: Using ${useSOL ? 'SOL' : 'USDC'}, amount: ${useSOL ? QUOTE_AMOUNT_SOL : QUOTE_AMOUNT_USDC}`);

      // We'll build the "swap" transaction from the DLMM SDK:
      // This normally includes instructions for the TransferChecked (etc.) from your inToken ATA
      // But we won't send it yet. We'll add the WSOL creation if needed.
      const swapBN = new BN(swapLamports);
      const isSwapYtoX = dlmmPool.tokenY.publicKey.equals(inMint);
      const binArrays = await dlmmPool.getBinArrayForSwap(isSwapYtoX);
      const swapQuote = dlmmPool.swapQuote(
        swapBN,
        isSwapYtoX,
        new BN(SNIPE_SLIPPAGE_BPS),
        binArrays
      );

      console.log(
        `Swapping ${useSOL ? QUOTE_AMOUNT_SOL + ' SOL' : QUOTE_AMOUNT_USDC + ' USDC'}`
      );
      console.log('swapQuote =>', {
        inAmount: swapQuote.consumedInAmount.toString(),
        outAmount: swapQuote.outAmount.toString(),
        minOut: swapQuote.minOutAmount.toString(),
        priceImpact: swapQuote.priceImpact.toString(),
      });

      // Build the swap tx.  By default, 'swap' returns a Transaction with the necessary instructions in it.
      const swapTx = await dlmmPool.swap({
        inToken: isSwapYtoX
          ? dlmmPool.tokenY.publicKey
          : dlmmPool.tokenX.publicKey,
        outToken: outMint,
        inAmount: swapQuote.consumedInAmount,
        minOutAmount: swapQuote.minOutAmount,
        lbPair: dlmmPool.pubkey,
        user: SNIPER_KEYPAIR.publicKey,
        binArraysPubkey: swapQuote.binArraysPubkey,
      });

      // Ensure we have an ATA for the outMint
      await getOrCreateAssociatedTokenAccount(
        this.connection,
        SNIPER_KEYPAIR,
        outMint,
        SNIPER_KEYPAIR.publicKey
      );

      // If not using SOL, we assume you have a USDC ATA with enough balance
      // If using SOL, we must add instructions to wrap SOL in the same transaction
      // so that the simulator sees the brand-new WSOL account with enough funds
      if (useSOL) {
        // 1) find or create WSOL ATA
        const wsolAta = await getOrCreateAssociatedTokenAccount(
          this.connection,
          SNIPER_KEYPAIR,
          NATIVE_MINT,
          SNIPER_KEYPAIR.publicKey
        );
        // 2) figure out rentExemption
        const rentExemption = await this.connection.getMinimumBalanceForRentExemption(
          165 // token account
        );
        const totalLamports = rentExemption + swapLamports;
        console.log('Debug wrap amounts:', {
          swapAmount: (swapLamports / LAMPORTS_PER_SOL).toFixed(6) + ' SOL',
          rentExemption: (rentExemption / LAMPORTS_PER_SOL).toFixed(6) + ' SOL',
          total: (totalLamports / LAMPORTS_PER_SOL).toFixed(6) + ' SOL'
        });

        // 3) Prepend the deposit + sync instructions to the *same* swapTx
        const wrapIx1 = SystemProgram.transfer({
          fromPubkey: SNIPER_KEYPAIR.publicKey,
          toPubkey: wsolAta.address,
          lamports: totalLamports,
        });
        const wrapIx2 = createSyncNativeInstruction(wsolAta.address);

        // put them at the front
        swapTx.instructions.unshift(wrapIx1, wrapIx2);
      }

      // Done building.  Now we sign and send the single transaction.
      // The swapTx now includes wrap + sync (if SOL) plus the actual swap instructions.
      const blockhashObj = await this.connection.getLatestBlockhash('confirmed');
      swapTx.feePayer = SNIPER_KEYPAIR.publicKey;
      swapTx.recentBlockhash = blockhashObj.blockhash;
      swapTx.sign(SNIPER_KEYPAIR);

      const txSig = await this.connection.sendRawTransaction(swapTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      console.log(`Snipe TX => ${txSig}, waiting for confirmation...`);

      // confirm
      const confirmRes = await this.connection.confirmTransaction({
        signature: txSig,
        blockhash: blockhashObj.blockhash,
        lastValidBlockHeight: blockhashObj.lastValidBlockHeight,
      }, 'confirmed');

      if (confirmRes.value.err) {
        console.error('❌ Swap transaction error =>', confirmRes.value.err);
      } else {
        console.log(`✅ Snipe success => swapped the non‐SOL/USDC side for us!`);
      }

    } catch (err) {
      console.error('❌ snipePool error:', err);
    }
  }
}

// Simple CLI
function parseCliArgs() {
  const args = process.argv.slice(2);
  return {
    isTestMode: args.includes('--test'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function displayHelp() {
  console.log(`
DLMM Sniper (ANY-Token Pools) - Usage:
  npx ts-node src/meteora/super-sniper-dynamicamm.ts [options]

Options:
  --test     Run in test mode
  --help,-h  Display help
`);
}

if (require.main === module) {
  const { isTestMode, help } = parseCliArgs();
  if (help) {
    displayHelp();
    process.exit(0);
  }

  if (isTestMode) {
    console.log('\n🧪 No specific test code here; you can adapt from older examples. Exiting...');
    process.exit(0);
  } else {
    const sniper = new DlmmPoolSniper(RPC_ENDPOINT, WS_MAINNET_ENDPOINT);
    sniper.start();
    console.log('Press Ctrl+C to exit...');
  }
}
