import 'dotenv/config'; 
import WebSocket from 'ws';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from '@solana/web3.js';

import bs58 from 'bs58';
import { BN } from 'bn.js';

// Official DLMM TS client
import DLMM from '@meteora-ag/dlmm';

// Jito-based function from jito/send-bundle.ts
import { sendBundle } from '../jito/send-bundle';
import type { BlockhashWithExpiryBlockHeight } from './execute-txns-meteora';

// Our updated meteora helpers
import {
  createWrapSolInstructions,
  getOrCreateMeteoraAta,
} from './execute-txns-meteora';

// The fetch-pool logic
import {
  fetchAllPoolStats,
  fetchDLMMPool,
} from './Pool/fetch-pool';


///////////////////////////////////////////////////////////////////////////////////
// ENV + Config
///////////////////////////////////////////////////////////////////////////////////
const NETWORK_ENV = process.env.NETWORK || 'mainnet';
const MAINNET_ENDPOINT = process.env.MAINNET_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const DEVNET_ENDPOINT  = process.env.DEVNET_ENDPOINT  || 'https://api.devnet.solana.com';

const RPC_ENDPOINT = (NETWORK_ENV === 'devnet')
  ? DEVNET_ENDPOINT
  : MAINNET_ENDPOINT;

// We'll open a WS subscription if you have that set, or fallback
const WS_MAINNET_ENDPOINT = process.env.WS_MAINNET_ENDPOINT
  || 'wss://mainnet.helius-rpc.com/?api-key=XXXX';

const SNIPER_PRIVATE_KEY_B58 =
  process.env.SWAP_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!SNIPER_PRIVATE_KEY_B58) {
  throw new Error('No SWAP_PRIVATE_KEY or PRIVATE_KEY found in .env');
}
const SNIPER_KEYPAIR = Keypair.fromSecretKey(
  bs58.decode(SNIPER_PRIVATE_KEY_B58)
);

// Decide if we want SOL or USDC for sniping
const FORCE_SOL = process.env.QUOTE_MINT === 'WSOL';
const QUOTE_AMOUNT_USDC = parseFloat(process.env.QUOTE_AMOUNT_USDC || '5');
const QUOTE_AMOUNT_SOL  = parseFloat(process.env.QUOTE_AMOUNT_SOL  || '0.001');
const SNIPE_SLIPPAGE_BPS = parseInt(process.env.SNIPE_SLIPPAGE_BPS || '10000');
const MIN_LIQUIDITY_SOL = parseFloat(process.env.MIN_LIQUIDITY_SOL || '0.001');

///////////////////////////////////////////////////////////////////////////////////
// Some known public keys
///////////////////////////////////////////////////////////////////////////////////
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL_MINT  = new PublicKey('So11111111111111111111111111111111111111112');
const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

///////////////////////////////////////////////////////////////////////////////////

interface HeliusTransaction {
  meta: {
    err: any;
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

// Add Jito validator list
const JITO_VALIDATORS = [
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
];

// Function to get random validator
function getRandomValidator(): PublicKey {
  const validator = JITO_VALIDATORS[Math.floor(Math.random() * JITO_VALIDATORS.length)];
  return new PublicKey(validator);
}

///////////////////////////////////////////////////////////////////////////////////
export class DlmmPoolSniper {
  private ws: WebSocket | null = null;
  private connection: Connection;
  private processedTxCount = 0;
  private processedPools: Set<string> = new Set();

  constructor(private rpcURL: string, private wsUrl: string) {
    this.connection = new Connection(rpcURL, 'confirmed');
  }

  public start() {
    console.log(`\n🔫 Starting Jito-based ANY-pool DLMM sniper on [${NETWORK_ENV}]`);
    console.log(`RPC => ${this.rpcURL}`);
    console.log(`WS => ${this.wsUrl}`);
    console.log(`Sniper => ${SNIPER_KEYPAIR.publicKey.toBase58()}`);
    console.log(`Using ${FORCE_SOL ? 'SOL' : 'USDC'} side, amounts =>`, QUOTE_AMOUNT_USDC, 'USDC /', QUOTE_AMOUNT_SOL, 'SOL');
    console.log(`Slippage => ${SNIPE_SLIPPAGE_BPS} BPS, min liq => ${MIN_LIQUIDITY_SOL} SOL eq\n`);

    this.initWebSocketSubscription();
    this.startApiBackupInterval();
  }

  private initWebSocketSubscription() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
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
      console.log('Listening for new DLMM pool creation TXNs...');
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

        const initPoolIx = transaction.message.instructions.find(
          (ix) => ix.programId === DLMM_PROGRAM_ID
        );
        if (!initPoolIx) return;

        // handle potential new pool
        await this.handleNewPool(msg.params.result);

      } catch (err) {
        console.error('WS parse error =>', err);
      }
    });

    this.ws.on('close', () => {
      console.log('❌ WS closed, reconnecting in 50s...');
      setTimeout(() => this.initWebSocketSubscription(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('⚠️  WS error =>', err);
    });
  }

  private startApiBackupInterval() {
    setInterval(async () => {
      try {
        const pools = await fetchAllPoolStats('');
        for (const poolInfo of pools) {
          const lbPairAddr = poolInfo.address;
          if (this.processedPools.has(lbPairAddr)) continue;

          // Only log when we find a new unprocessed pool
          console.log(`[API-Backup] Found new pool => ${poolInfo.name} => ${lbPairAddr}`);
          const dlmmPool = await fetchDLMMPool(lbPairAddr);

          await this.attemptSnipeDlmmPool(dlmmPool, lbPairAddr);
          this.processedPools.add(lbPairAddr);
          
          // Add delay between attempts (5s instead of 500ms)
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } catch (err) {
        console.error('[API-Backup] error =>', err);
      }
    }, 50000);
  }

  private async handleNewPool(txInfo: HeliusTransaction) {
    try {
      const lbPairPubkey = await this.findLbPairPubkey(txInfo);
      if (!lbPairPubkey) {
        return;
      }
      if (this.processedPools.has(lbPairPubkey.toBase58())) {
        return;
      }
      const dlmmPool = await DLMM.create(this.connection, lbPairPubkey);
      await this.attemptSnipeDlmmPool(dlmmPool, lbPairPubkey.toBase58());
      this.processedPools.add(lbPairPubkey.toBase58());
    } catch (err) {
      console.error('Error in handleNewPool =>', err);
    }
  }

  private async findLbPairPubkey(_txInfo: HeliusTransaction): Promise<PublicKey | null> {
    // TODO: parse logs or postTokenBalances for LB pair address.
    // For now, returning null
    return null;
  }

  private async attemptSnipeDlmmPool(dlmmPool: any, poolAddr: string) {
    const { tokenX, tokenY } = dlmmPool;
    const hasUSDC = tokenX.publicKey.equals(USDC_MINT) || tokenY.publicKey.equals(USDC_MINT);
    const hasSOL  = tokenX.publicKey.equals(SOL_MINT)  || tokenY.publicKey.equals(SOL_MINT);

    if (!hasUSDC && !hasSOL) {
      return; // Skip logging for pools we're not interested in
    }

    // check liquidity
    const humX = Number(dlmmPool.tokenX.amount.toString()) / 10 ** dlmmPool.tokenX.decimal;
    const humY = Number(dlmmPool.tokenY.amount.toString()) / 10 ** dlmmPool.tokenY.decimal;

    let solEq = 0;
    if (dlmmPool.tokenX.publicKey.equals(SOL_MINT)) solEq += humX;
    if (dlmmPool.tokenY.publicKey.equals(SOL_MINT)) solEq += humY;
    if (dlmmPool.tokenX.publicKey.equals(USDC_MINT)) solEq += humX * 0.5;
    if (dlmmPool.tokenY.publicKey.equals(USDC_MINT)) solEq += humY * 0.5;

    if (solEq < MIN_LIQUIDITY_SOL) {
      return; // Skip logging for pools with insufficient liquidity
    }

    console.log(`\n🔫 Attempting snipe => pool ${poolAddr}, hasUSDC=${hasUSDC}, hasSOL=${hasSOL}`);
    // Only use SOL if FORCE_SOL is true AND the pool has SOL
    const useSOL = FORCE_SOL && hasSOL;
    await this.snipePool(dlmmPool, useSOL, poolAddr);
  }

  /**
   * The key method that uses Jito's "sendBundle".
   * We build a versioned transaction for the deposit-wsol + dlmm swap instructions, then pass it to Jito.
   */
  private async snipePool(dlmmPool: any, useSOL: boolean, poolAddr?: string) {
    try {
      // Decide how many lamports to trade
      const lamportsNeeded = useSOL
        ? Math.floor(QUOTE_AMOUNT_SOL * LAMPORTS_PER_SOL)
        : Math.floor(QUOTE_AMOUNT_USDC * 1_000_000); // USDC => 6 decimals

      console.log(`\n🎯 Attempting snipe on ${poolAddr}`);
      console.log(`Input: ${useSOL ? (lamportsNeeded / LAMPORTS_PER_SOL).toFixed(3) + ' SOL' : (lamportsNeeded / 1_000_000).toFixed(2) + ' USDC'}`);

      // figure out inMint / outMint
      let inMint: PublicKey;
      let outMint: PublicKey;
      const xIsQuote = dlmmPool.tokenX.publicKey.equals(USDC_MINT)
                    || dlmmPool.tokenX.publicKey.equals(SOL_MINT);

      if (xIsQuote) {
        inMint = dlmmPool.tokenX.publicKey;
        outMint = dlmmPool.tokenY.publicKey;
      } else {
        inMint = dlmmPool.tokenY.publicKey;
        outMint = dlmmPool.tokenX.publicKey;
      }

      if (useSOL && !inMint.equals(SOL_MINT)) {
        console.log('inverting to pick SOL side...');
        [inMint, outMint] = [outMint, inMint];
      } else if (!useSOL && !inMint.equals(USDC_MINT)) {
        console.log('inverting to pick USDC side...');
        [inMint, outMint] = [outMint, inMint];
      }

      // gather the bin arrays
      const isSwapYtoX = dlmmPool.tokenY.publicKey.equals(inMint);
      const binArrays = await dlmmPool.getBinArrayForSwap(isSwapYtoX);

      // build swap quote
      const swapBN = new BN(lamportsNeeded);
      const swapQuote = dlmmPool.swapQuote(
        swapBN,
        isSwapYtoX,
        new BN(SNIPE_SLIPPAGE_BPS),
        binArrays
      );
      console.log(`Expected Output: ${(Number(swapQuote.outAmount) / 10 ** dlmmPool.tokenY.decimal).toFixed(4)} tokens`);

      // If we are using SOL, we must deposit lamports into WSOL first
      let wsolAta: PublicKey | undefined;
      if (useSOL) {
        const wsolAcct = await getOrCreateMeteoraAta(
          this.connection,
          SNIPER_KEYPAIR,
          SOL_MINT,
          SNIPER_KEYPAIR.publicKey
        );
        wsolAta = wsolAcct.address;
      }

      // Also ensure we have an ATA for outMint
      await getOrCreateMeteoraAta(
        this.connection,
        SNIPER_KEYPAIR,
        outMint,
        SNIPER_KEYPAIR.publicKey
      );

      // Build the dlmm swap instructions
      const swapTx = await dlmmPool.swap({
        inToken: isSwapYtoX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey,
        outToken: outMint,
        inAmount: swapQuote.consumedInAmount,
        minOutAmount: swapQuote.minOutAmount,
        lbPair: dlmmPool.pubkey,
        user: SNIPER_KEYPAIR.publicKey,
        binArraysPubkey: swapQuote.binArraysPubkey,
        ...(useSOL
          ? isSwapYtoX
            ? { userTokenY: wsolAta }
            : { userTokenX: wsolAta }
          : {}
        ),
      });

      // combine instructions in array
      const instructions: TransactionInstruction[] = [...swapTx.instructions];

      // if useSOL, deposit rent + lamports into wsol
      if (useSOL && wsolAta) {
        instructions.unshift(...await createWrapSolInstructions(
          this.connection,
          SNIPER_KEYPAIR.publicKey,
          wsolAta,
          lamportsNeeded
        ));
      }

      //
      // Build a versioned transaction for Jito
      //
      const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
      const messageV0 = new TransactionMessage({
        payerKey: SNIPER_KEYPAIR.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message();
      const vt = new VersionedTransaction(messageV0);
      vt.sign([SNIPER_KEYPAIR]);

      // Create tip transaction
      const tipAmount = 0.001 * LAMPORTS_PER_SOL;
      const tipValidator = getRandomValidator();
      console.log(`Selected Jito validator: ${tipValidator.toBase58()}`);

      const tipMessage = new TransactionMessage({
        payerKey: SNIPER_KEYPAIR.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: SNIPER_KEYPAIR.publicKey,
            toPubkey: tipValidator,
            lamports: tipAmount,
          }),
        ],
      }).compileToV0Message();
      
      const tipTx = new VersionedTransaction(tipMessage);
      tipTx.sign([SNIPER_KEYPAIR]);

      let bundleResult: any;
      await sendBundle(
        SNIPER_KEYPAIR,
        this.connection,
        async (_blockHash: BlockhashWithExpiryBlockHeight, _tipAccount: PublicKey) => {
          return [tipTx, vt];
        },
        5,
        30000
      ).then((result) => {
        bundleResult = result;
      }).catch((err) => {
        if (err.message?.includes('Rate limit exceeded')) {
          console.log('⏳ Rate limit hit, waiting 10s before retry...');
          return new Promise(resolve => setTimeout(resolve, 10000));
        }
        throw err;
      });

      if (bundleResult?.accepted) {
        console.log('\n✅ SNIPE SUCCESSFUL!');
        console.log(`Slot: ${bundleResult.accepted.slot}`);
        console.log(`Validator: ${bundleResult.accepted.validatorIdentity}`);
        process.exit(0); // Exit on success
      } else if (bundleResult?.rejected) {
        console.log('\n❌ Bundle rejected:', bundleResult.rejected);
      } else {
        console.log('\n⚠️ Bundle status unknown');
      }

    } catch (err: any) {
      if (err.message?.includes('Rate limit exceeded')) {
        console.log('⏳ Rate limit hit, waiting 10s...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      } else {
        console.error('\n❌ Snipe failed:', err.message || err);
      }
    }
  }
}

// If run directly:
if (require.main === module) {
  const sniper = new DlmmPoolSniper(RPC_ENDPOINT, WS_MAINNET_ENDPOINT);
  sniper.start();
  console.log('Press Ctrl + C to exit...');
}
