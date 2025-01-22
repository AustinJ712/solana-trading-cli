/**
 * super-sniper-dynamicamm.ts
 *
 * Listens for new pools created by the Meteora DLMM (dynamic-liquidity market making) program
 * and immediately attempts to swap (buy) the target token using either SOL or USDC,
 * reading from environment variables in .env.
 *
 * In this version, we specifically focus on DLMM pools — that is, the Meteora "dlmm-sdk"
 * load address. We detect the "initialize pool" instruction and parse the new
 * pool address (for example, from logs, postTokenBalances, or the program's `PoolCreated` event).
 * Once we find that new DLMM pool, if it includes our target token and the other side is SOL or USDC,
 * we snipe it immediately.
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
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { BN } from 'bn.js';

// SPL helpers for ATA creation (fixes swap failures due to missing associated token accounts)
import {
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';

// Import the official DLMM TS client from your local or npm
import DLMM, { SwapQuote } from '@meteora-ag/dlmm';

// Some constants from the TS client if needed

///////////////////////////////////////////////////////////////////////////////////
// ENV variables
///////////////////////////////////////////////////////////////////////////////////
const NETWORK_ENV = process.env.NETWORK || 'mainnet'; // 'mainnet' or 'devnet'
const MAINNET_ENDPOINT = process.env.MAINNET_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const DEVNET_ENDPOINT  = process.env.DEVNET_ENDPOINT  || 'https://api.devnet.solana.com';

const RPC_ENDPOINT = (NETWORK_ENV === 'devnet') ? DEVNET_ENDPOINT : MAINNET_ENDPOINT;

// Helius websockets for mainnet, or your own aggregator:
const WS_MAINNET_ENDPOINT = process.env.WS_MAINNET_ENDPOINT || 'wss://mainnet.helius-rpc.com/?api-key=XXXX';

// This is your sniping keypair that holds SOL or USDC to do the snipe
const SNIPER_PRIVATE_KEY_B58 = process.env.SWAP_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!SNIPER_PRIVATE_KEY_B58) {
  throw new Error('No SWAP_PRIVATE_KEY or PRIVATE_KEY found in .env');
}
const SNIPER_KEYPAIR = Keypair.fromSecretKey(bs58.decode(SNIPER_PRIVATE_KEY_B58));

// Your target token from .env:
const TARGET_TOKEN_ADDRESS = process.env.TARGET_TOKEN_ADDRESS;
if (!TARGET_TOKEN_ADDRESS) {
  throw new Error('No TARGET_TOKEN_ADDRESS provided in .env');
}
const TARGET_TOKEN_MINT = new PublicKey(TARGET_TOKEN_ADDRESS);
console.log(`🎯 Target token to snipe: ${TARGET_TOKEN_ADDRESS}`);

// Decide whether we're forcing SOL or letting USDC be used
// If QUOTE_MINT=WSOL => we force SOL, otherwise prefer USDC
const FORCE_SOL = (process.env.QUOTE_MINT === 'WSOL');

// The buy amount in USDC (or SOL if the pool only has SOL or if forcing SOL)
const QUOTE_AMOUNT = parseFloat(process.env.QUOTE_AMOUNT || '5');

// Slippage in BPS (e.g. 100 => 1%)
const SNIPE_SLIPPAGE_BPS = parseInt(process.env.SNIPE_SLIPPAGE_BPS || '10000');

// Minimum liquidity threshold in SOL equivalent (optional)
const MIN_LIQUIDITY_SOL = parseFloat(process.env.MIN_LIQUIDITY_SOL || '0.001');

// If we do USDC, specify the mainnet mint
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// The canonical WSOL mint
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * The official LB-CLMM (DLMM) program ID can differ based on cluster. The TS client
 * typically uses an internal mapping, e.g. LBCLMM_PROGRAM_IDS[cluster].
 * If needed, you could do so here.
 */
// For demonstration, we assume the user wants to detect new dlmm pools from their known program ID.
const DLMM_PROGRAM_ID = 'LbVRzDTvBDEcrthxfZ4RL6yiq3uZw8bS6MwtdY6UhFQ'; // example placeholder

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
        data: string; // base58-encoded instruction data
        accounts?: string[];
      }>;
    };
  };
  signature: string;
}

interface HeliusRealtimeMessage {
  jsonrpc: string;
  method: string; // "transactionNotify", "transactionNotification", etc
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

  constructor(private rpcURL: string, private wsUrl: string) {
    this.connection = new Connection(rpcURL, 'confirmed');
  }

  public start() {
    console.log(`🚀 Starting DLMM sniper on ${NETWORK_ENV}, using RPC: ${this.rpcURL}`);
    console.log(`Sniper wallet: ${SNIPER_KEYPAIR.publicKey.toBase58()}`);
    console.log(`WS endpoint: ${this.wsUrl}`);
    console.log(`Will swap with ${FORCE_SOL ? 'SOL' : 'USDC'} for target token: ${TARGET_TOKEN_ADDRESS}`);
    console.log(`Quote amount: ${QUOTE_AMOUNT}, slippage BPS: ${SNIPE_SLIPPAGE_BPS}, min liquidity: ${MIN_LIQUIDITY_SOL}\n`);

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('✅ WebSocket connected for dlmm sniper');

      // We subscribe to the known DLMM program ID
      const subscription = {
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [
          {
            accountInclude: [DLMM_PROGRAM_ID],
            failed: false
          },
          {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
            transactionDetails: 'full'
          }
        ],
      };
      this.ws!.send(JSON.stringify(subscription));
      console.log('Listening for new DLMM pool transactions...');
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as HeliusRealtimeMessage;
        if (!msg.params || !msg.params.result) return;

        const { transaction, meta, signature } = msg.params.result;
        if (meta.err) return; // skip failed TXs

        this.processedTxCount++;
        if (this.processedTxCount % 100 === 0) {
          console.log(`Processed ${this.processedTxCount} dlmm tx so far...`);
        }

        // Possibly detect "initializeCustomizablePermissionlessLbPair" or "initializeLbPair" instructions
        const dlmmProgramId = DLMM_PROGRAM_ID;
        const initPoolIx = transaction.message.instructions.find((ix) => {
          return ix.programId === dlmmProgramId;
          // Additional logic could decode the data to confirm it's the correct init pool instruction
        });
        if (!initPoolIx) {
          // Not a new pool creation
          return;
        }

        await this.handleNewPool(msg.params.result);
      } catch (err) {
        console.error('WS message parse error', err);
      }
    });

    this.ws.on('close', () => {
      console.log('❌ WebSocket closed, reconnecting in 5s...');
      setTimeout(() => this.start(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('⚠️ WebSocket error:', err);
    });
  }

  /**
   * Attempt to parse the newly created LB pair address from the transaction.
   * Then check if it includes the target token with SOL or USDC.
   * If it meets liquidity requirements, do a swap.
   */
  private async handleNewPool(txInfo: HeliusTransaction) {
    const { transaction, meta, signature } = txInfo;
    try {
      // We'll do a placeholder for demonstration — parse logs or postTokenBalances to find the new pool
      const lbPairPubkey = await this.findLbPairPubkey(txInfo);
      if (!lbPairPubkey) {
        console.log('Could not find new LB pair address in TX. Skipping...');
        return;
      }

      // Create an instance of DLMM
      const dlmmPool = await DLMM.create(this.connection, lbPairPubkey, {
        cluster: NETWORK_ENV === 'mainnet' ? 'mainnet-beta' : 'devnet',
      });

      // Check if it has the target token
      const { tokenX, tokenY, lbPair } = dlmmPool;
      const hasTargetX = tokenX.publicKey.equals(TARGET_TOKEN_MINT);
      const hasTargetY = tokenY.publicKey.equals(TARGET_TOKEN_MINT);
      if (!hasTargetX && !hasTargetY) {
        console.log(`DLMM pool ${lbPairPubkey.toBase58()} does not contain our target token.`);
        return;
      }

      // Check the "other side" is USDC or SOL
      const otherMint = hasTargetX ? tokenY.publicKey : tokenX.publicKey;
      const hasUSDC = otherMint.equals(USDC_MINT);
      const hasSOL  = otherMint.equals(SOL_MINT);

      if (FORCE_SOL && !hasSOL) {
        console.log('Forcing SOL but pool uses USDC. Skipping...');
        return;
      }
      if (!FORCE_SOL && !hasUSDC && !hasSOL) {
        console.log('Pool does not contain USDC or SOL. Skipping...');
        return;
      }

      // Check liquidity: approximate in SOL eq
      // For DLMM, you can read dlmmPool.tokenX.amount, dlmmPool.tokenY.amount from the on-chain reserve.
      // Then approximate
      let solEq = 0;
      let amountX = Number(dlmmPool.tokenX.amount.toString()); // raw integer
      let amountY = Number(dlmmPool.tokenY.amount.toString());

      // Convert based on decimals
      const humX = amountX / 10 ** dlmmPool.tokenX.decimal;
      const humY = amountY / 10 ** dlmmPool.tokenY.decimal;

      if (dlmmPool.tokenX.publicKey.equals(SOL_MINT)) {
        solEq += humX;
      }
      if (dlmmPool.tokenY.publicKey.equals(SOL_MINT)) {
        solEq += humY;
      }
      // Rough approximation: 1 USDC ~ 0.5 SOL
      if (dlmmPool.tokenX.publicKey.equals(USDC_MINT)) {
        solEq += humX * 0.5;
      }
      if (dlmmPool.tokenY.publicKey.equals(USDC_MINT)) {
        solEq += humY * 0.5;
      }

      if (solEq < MIN_LIQUIDITY_SOL) {
        console.log(`Liquidity too low (~${solEq.toFixed(2)} SOL eq). Skipping...`);
        return;
      }

      console.log(`\n🏦 New valid DLMM pool: ${lbPairPubkey.toBase58()} => target token + ${hasUSDC ? 'USDC' : 'SOL'}. Attempting snipe...`);
      const useSOL = FORCE_SOL || (!hasUSDC && hasSOL);
      await this.snipePool(dlmmPool, useSOL);
    } catch (err) {
      console.error('Error in handleNewPool:', err);
    }
  }

  /**
   * Placeholder: parse logs or postTokenBalances to find the new LB pair address
   */
  private async findLbPairPubkey(txInfo: HeliusTransaction): Promise<PublicKey | undefined> {
    // You would parse logs or balances here. We'll just return a dummy address to continue the flow.
    return new PublicKey('11111111111111111111111111111111');
  }

  /**
   * Execute swap to buy the target token. DLMM has a different code path than mercurial's dynamic-amm.
   */
  private async snipePool(dlmmPool: any, useSOL: boolean) {
    try {
      // The "inToken" is either SOL or USDC
      const inMint = useSOL ? SOL_MINT : USDC_MINT;
      // The outMint is the target
      // figure out which side of the DLMM is the target
      let outMint: PublicKey;
      if (dlmmPool.tokenX.publicKey.equals(TARGET_TOKEN_MINT)) {
        outMint = dlmmPool.tokenX.publicKey;
      } else {
        outMint = dlmmPool.tokenY.publicKey;
      }

      const lamports = QUOTE_AMOUNT * LAMPORTS_PER_SOL;
      // In DLMM, the TS client has a `swapQuote(...)` method,
      // but we can also do "swap" directly if we want.

      // We must ensure we have ATA for inMint & outMint
      const user = SNIPER_KEYPAIR.publicKey;
      // (1) Create ATA for the outMint
      await getOrCreateAssociatedTokenAccount(
        this.connection,
        SNIPER_KEYPAIR,
        outMint,
        user
      );

      // (2) If using SOL, wrap it
      let inTokenAta: PublicKey;
      if (useSOL) {
        // Must create WSOL, deposit SOL, etc.
        const wsolAta = await getOrCreateAssociatedTokenAccount(
          this.connection,
          SNIPER_KEYPAIR,
          NATIVE_MINT,
          user
        );
        inTokenAta = wsolAta.address;
        // deposit SOL
        const wrapTx = await this.buildWrapSolTx(wsolAta.address, lamports);
        const sig = await this.connection.sendTransaction(wrapTx, [SNIPER_KEYPAIR]);
        console.log(`Wrap SOL TX => ${sig}, waiting...`);
        await this.connection.confirmTransaction(sig, 'confirmed');
      } else {
        // Just get a USDC ATA
        const usdcAta = await getOrCreateAssociatedTokenAccount(
          this.connection,
          SNIPER_KEYPAIR,
          inMint,
          user
        );
        inTokenAta = usdcAta.address;
      }

      // Next, build a swap quote. We'll do a "swapExactIn" approach
      // to avoid partial fill complexities. We can do a slippage-based minOut.
      // The dlmmPool has `swapQuote(...)`.
      const swapAmount = new BN(lamports);
      const isSwapYtoX = dlmmPool.tokenY.publicKey.equals(inMint); // if user inMint is Y
      // We retrieve binArrays for the swap:
      const binArrays = await dlmmPool.getBinArrayForSwap(isSwapYtoX);
      // Then we do a normal "swapQuote".
      // "allowedSlippage" in the library is BPS
      const swapQuote = dlmmPool.swapQuote(
        swapAmount,
        isSwapYtoX,
        new BN(SNIPE_SLIPPAGE_BPS),
        binArrays
      );

      console.log(`Swap quote => in: ${swapQuote.consumedInAmount.toString()}, out: ${swapQuote.outAmount.toString()}`);
      console.log(`Price impact => ${swapQuote.priceImpact.toFixed(3)} %`);
      // Then we build the actual swap transaction
      const swapTx = await dlmmPool.swap({
        inToken: dlmmPool.tokenX.publicKey.equals(inMint)
          ? dlmmPool.tokenX.publicKey
          : dlmmPool.tokenY.publicKey,
        outToken: outMint,
        inAmount: swapQuote.consumedInAmount,
        minOutAmount: swapQuote.minOutAmount,
        lbPair: dlmmPool.pubkey,
        user,
        binArraysPubkey: swapQuote.binArraysPubkey,
      });
      // sign & send
      const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
      swapTx.feePayer = user;
      swapTx.recentBlockhash = latestBlockhash.blockhash;
      swapTx.sign(SNIPER_KEYPAIR);
      const txSig = await this.connection.sendRawTransaction(swapTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      console.log(`Swap sent => ${txSig}`);

      const confirmRes = await this.connection.confirmTransaction({
        signature: txSig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      }, 'confirmed');
      if (confirmRes.value.err) {
        console.error(`Swap error => `, confirmRes.value.err);
      } else {
        console.log(`✅ Snipe success => swapped for target token (DLMM)`);
      }
    } catch (err) {
      console.error('❌ snipePool error:', err);
    }
  }

  /**
   * Build a simple transaction that wraps SOL into an existing WSOL ATA
   */
  private async buildWrapSolTx(wsolAta: PublicKey, lamports: number) {
    const tx = new Transaction();
    tx.add(
      SystemProgram.transfer({
        fromPubkey: SNIPER_KEYPAIR.publicKey,
        toPubkey: wsolAta,
        lamports,
      }),
      createSyncNativeInstruction(wsolAta)
    );
    tx.feePayer = SNIPER_KEYPAIR.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
    return tx;
  }
}

// Command line argument parser
function parseCliArgs() {
  const args = process.argv.slice(2);
  return {
    isTestMode: args.includes('--test'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

// Display help message
function displayHelp() {
  console.log(`
DLMM Sniper - Usage:
  npx ts-node src/meteora/super-sniper-dynamicamm.ts [options]

Options:
  --test     Run in test mode to verify configuration and functionality
  --help,-h  Display this help message

Examples:
  npx ts-node src/meteora/super-sniper-dynamicamm.ts             Start the sniper in live mode
  npx ts-node src/meteora/super-sniper-dynamicamm.ts --test      Run in test mode
  `);
}

// If run directly
if (require.main === module) {
  const { isTestMode, help } = parseCliArgs();

  if (help) {
    displayHelp();
    process.exit(0);
  }

  if (isTestMode) {
    console.log('\n🧪 Running in test mode...');
    testDlmmSniper();
  } else {
    const sniper = new DlmmPoolSniper(RPC_ENDPOINT, WS_MAINNET_ENDPOINT);
    sniper.start();
    console.log('Press Ctrl+C to exit...');
  }
}

/**
 * Test mode function to verify the DLMM sniper functionality
 */
async function testDlmmSniper() {
  const TEST_AMOUNT = 5;
  console.log('Testing DLMM Sniper functionality...');
  console.log('Sniper wallet:', SNIPER_KEYPAIR.publicKey.toString());
  console.log(`Target token: ${TARGET_TOKEN_ADDRESS}`);
  console.log(`Using ${FORCE_SOL ? 'SOL' : 'USDC'} for purchases`);
  console.log(`Test amount: ${TEST_AMOUNT} ${FORCE_SOL ? 'SOL' : 'USDC'}`);
  console.log(`Slippage: ${SNIPE_SLIPPAGE_BPS} BPS`);
  console.log(`Min liquidity: ${MIN_LIQUIDITY_SOL} SOL\n`);

  try {
    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    console.log('Testing RPC connection...');
    const bh = await connection.getBlockHeight();
    console.log('✅ RPC block height:', bh);

    // Pick an existing DLMM pool address for test
    const testPool = process.env.TEST_POOL_ADDRESS || (
      FORCE_SOL
        ? '11111111111111111111111111111111' // placeholder SOL pool
        : '22222222222222222222222222222222' // placeholder USDC pool
    );
    console.log('\n🏦 Testing with LB Pair:', testPool);

    // Create the DLMM instance
    const dlmmPool = await DLMM.create(connection, new PublicKey(testPool), {
      cluster: NETWORK_ENV === 'mainnet' ? 'mainnet-beta' : 'devnet',
    });
    console.log('✅ Successfully loaded DLMM pool');

    // Display some pool info
    console.log('LB Pair address:', dlmmPool.pubkey.toBase58());
    console.log('Token X Mint:', dlmmPool.tokenX.publicKey.toBase58(), 'dec:', dlmmPool.tokenX.decimal);
    console.log('Token Y Mint:', dlmmPool.tokenY.publicKey.toBase58(), 'dec:', dlmmPool.tokenY.decimal);

    // Suppose we do a small test swap
    const inAmountLamports = new BN(TEST_AMOUNT * LAMPORTS_PER_SOL);
    const isSwapYtoX = dlmmPool.tokenY.publicKey.equals(FORCE_SOL ? SOL_MINT : USDC_MINT);

    // get bin arrays
    const binArrays = await dlmmPool.getBinArrayForSwap(isSwapYtoX);
    // get quote
    const swapQuote = dlmmPool.swapQuote(inAmountLamports, isSwapYtoX, new BN(SNIPE_SLIPPAGE_BPS), binArrays);
    console.log('Swap quote =>', {
      consumedInAmount: swapQuote.consumedInAmount.toString(),
      outAmount: swapQuote.outAmount.toString(),
      minOutAmount: swapQuote.minOutAmount.toString(),
      priceImpact: swapQuote.priceImpact.toNumber(),
    });

    // Build the tx
    const inMint = isSwapYtoX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey;
    const outMint = isSwapYtoX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey;
    const swapTx = await dlmmPool.swap({
      inToken: inMint,
      outToken: outMint,
      inAmount: swapQuote.consumedInAmount,
      minOutAmount: swapQuote.minOutAmount,
      lbPair: dlmmPool.pubkey,
      user: SNIPER_KEYPAIR.publicKey,
      binArraysPubkey: swapQuote.binArraysPubkey,
    });
    swapTx.feePayer = SNIPER_KEYPAIR.publicKey;
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    swapTx.recentBlockhash = latestBlockhash.blockhash;
    swapTx.sign(SNIPER_KEYPAIR);

    const txSig = await connection.sendRawTransaction(swapTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    console.log('Test swap TX =>', txSig);
    console.log(`Explorer link => https://solscan.io/tx/${txSig}`);

    // We won't wait for confirmation in the example
    console.log('✅ Test completed (transaction submitted).');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
}
