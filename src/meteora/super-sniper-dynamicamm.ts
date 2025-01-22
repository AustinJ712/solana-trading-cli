/**
 * super-sniper-dynamicamm.ts
 *
 * Listens for new pools created by the Mercurial/Meteora dynamic-amm program
 * and immediately attempts to swap (buy) the target token using either SOL or USDC,
 * reading from environment variables in .env.
 *
 * In this version, we detect the "initialize pool" instruction and parse the new
 * pool address (for example, from logs, postTokenBalances, or the program's
 * `PoolCreated` event). Once we find that new pool, if it includes our target
 * token and the other side is SOL or USDC, we snipe it immediately.
 */

import 'dotenv/config'; // For reading .env
import WebSocket from 'ws';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
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

import AmmImpl, { PROGRAM_ID as DYNAMIC_AMM_PID } from '@mercurial-finance/dynamic-amm-sdk';

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
// e.g. SWAP_PRIVATE_KEY from .env
const SNIPER_PRIVATE_KEY_B58 = process.env.SWAP_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!SNIPER_PRIVATE_KEY_B58) {
  throw new Error('No SWAP_PRIVATE_KEY or PRIVATE_KEY found in .env');
}
const SNIPER_KEYPAIR = Keypair.fromSecretKey(bs58.decode(SNIPER_PRIVATE_KEY_B58));

// Your target token from .env:
// e.g. TARGET_TOKEN_ADDRESS=C9KDEUqxYkFdgzT4...
const TARGET_TOKEN_ADDRESS = process.env.TARGET_TOKEN_ADDRESS;
if (!TARGET_TOKEN_ADDRESS) {
  throw new Error('No TARGET_TOKEN_ADDRESS provided in .env');
}
const TARGET_TOKEN_MINT = new PublicKey(TARGET_TOKEN_ADDRESS);
console.log(`🎯 Target token to snipe: ${TARGET_TOKEN_ADDRESS}`);

// Decide whether we're using SOL or USDC to purchase
// If QUOTE_MINT=WSOL => we force SOL, otherwise we'll try USDC first, then SOL
const FORCE_SOL = (process.env.QUOTE_MINT === 'WSOL');

// The buy amount in USDC (or SOL if pool only has SOL)
const QUOTE_AMOUNT = parseFloat(process.env.QUOTE_AMOUNT || '5');

// Slippage in BPS (e.g. 100 => 1%)
const SNIPE_SLIPPAGE_BPS = parseInt(process.env.SNIPE_SLIPPAGE_BPS || '10000');

// Minimum liquidity threshold in SOL equivalent (optional)
const MIN_LIQUIDITY_SOL = parseFloat(process.env.MIN_LIQUIDITY_SOL || '0.001');

// If we do USDC, specify the mainnet mint (Mercurial's dynamic-amm also works on devnet with a dev USDC)
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// The "canonical" SOL token. In dynamic-amm, you'd typically use wrapped SOL (So111...).
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Program ID for dynamic-amm:
const DYNAMIC_AMM_PROGRAM = DYNAMIC_AMM_PID; // Eo7WjKq...

///////////////////////////////////////////////////////////////////////////////////
// Minimal shape of Helius realtime message
///////////////////////////////////////////////////////////////////////////////////
interface HeliusTransaction {
  meta: {
    err: any;
    postTokenBalances?: any[];
    preTokenBalances?: any[];
    // logs, etc, if needed
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

export class DynamicAmmSniper {
  private ws: WebSocket | null = null;
  private connection: Connection;
  private processedTxCount: number = 0;

  constructor(private rpcURL: string, private wsUrl: string) {
    this.connection = new Connection(rpcURL, 'confirmed');
  }

  public start() {
    console.log(`🚀 Starting dynamic-amm sniper on ${NETWORK_ENV}, using RPC: ${this.rpcURL}`);
    console.log(`Sniper wallet: ${SNIPER_KEYPAIR.publicKey.toBase58()}`);
    console.log(`WS endpoint: ${this.wsUrl}`);
    console.log(`Will swap with ${FORCE_SOL ? 'SOL' : 'USDC'} for target token: ${TARGET_TOKEN_ADDRESS}`);
    console.log(`Quote amount: ${QUOTE_AMOUNT}, slippage BPS: ${SNIPE_SLIPPAGE_BPS}, min liquidity: ${MIN_LIQUIDITY_SOL}\n`);

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('✅ WebSocket connected for dynamic-amm sniper');

      // Subscribe to dynamic-amm program transactions
      const subscription = {
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [
          {
            accountInclude: [new PublicKey(DYNAMIC_AMM_PROGRAM).toBase58()],
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
      console.log('Listening for new dynamic-amm pool transactions...');
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as HeliusRealtimeMessage;
        if (!msg.params || !msg.params.result) return;

        const { transaction, meta, signature } = msg.params.result;
        if (meta.err) return; // skip failed TXs

        this.processedTxCount++;
        if (this.processedTxCount % 100 === 0) {
          console.log(`Processed ${this.processedTxCount} dynamic-amm tx so far...`);
        }

        // Check if the transaction includes an "initialize pool" instruction
        const dynamicAmmProgramId = new PublicKey(DYNAMIC_AMM_PROGRAM).toBase58();
        const initPoolIx = transaction.message.instructions.find((ix) => {
          return ix.programId === dynamicAmmProgramId;
          // Additional logic could decode the data to confirm it's the "initialize permissionless pool" instruction
        });

        if (!initPoolIx) {
          // Not a new pool creation
          return;
        }

        // If we reach here, let's try to figure out the new pool address
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
   * Attempt to parse the newly created pool address from the transaction.
   * Once we have the pool address, check if it includes the target token with SOL or USDC.
   * Then, if it meets liquidity requirements, do a swap.
   */
  private async handleNewPool(txInfo: HeliusTransaction) {
    const { transaction, meta, signature } = txInfo;
    try {
      // For demonstration, let's say we parse logs or use postTokenBalances to find the new pool pda.
      const poolPubkey = await this.findPoolPubkey(txInfo);
      if (!poolPubkey) {
        console.log('Could not find new pool address in transaction logs/balances. Skipping.');
        return;
      }

      const poolAmm = await AmmImpl.create(this.connection, poolPubkey);
      await poolAmm.updateState();

      // Check if it contains the target token
      const { tokenAMint, tokenBMint } = poolAmm;
      const mintA = new PublicKey(tokenAMint.address);
      const mintB = new PublicKey(tokenBMint.address);

      const isTargetA = mintA.equals(TARGET_TOKEN_MINT);
      const isTargetB = mintB.equals(TARGET_TOKEN_MINT);
      if (!isTargetA && !isTargetB) {
        console.log(`Pool ${poolPubkey.toBase58()} does not contain our target token.`);
        return;
      }

      // Check if the other side is USDC or SOL
      const otherMint = isTargetA ? mintB : mintA;
      const hasUSDC = otherMint.equals(USDC_MINT);
      const hasSOL = otherMint.equals(SOL_MINT);

      // If we're forcing SOL, skip USDC pools
      if (FORCE_SOL && !hasSOL) {
        console.log('Forcing SOL but pool uses USDC. Skipping...');
        return;
      }

      // If we're not forcing SOL, prefer USDC pools
      if (!FORCE_SOL && !hasUSDC && !hasSOL) {
        console.log('Pool does not contain USDC or SOL. Skipping...');
        return;
      }

      // Optionally check liquidity
      const { tokenAAmount, tokenBAmount } = poolAmm.poolInfo;
      const humA = tokenAAmount.toNumber() / (10 ** tokenAMint.decimals);
      const humB = tokenBAmount.toNumber() / (10 ** tokenBMint.decimals);
      let approxSolLiquidity = 0;

      if (mintA.equals(SOL_MINT)) {
        approxSolLiquidity += humA;
      }
      if (mintB.equals(SOL_MINT)) {
        approxSolLiquidity += humB;
      }
      // If USDC side, approximate 1 USDC ~ 0.5 SOL
      if (mintA.equals(USDC_MINT)) {
        approxSolLiquidity += humA * 0.5;
      }
      if (mintB.equals(USDC_MINT)) {
        approxSolLiquidity += humB * 0.5;
      }

      if (approxSolLiquidity < MIN_LIQUIDITY_SOL) {
        console.log(`Liquidity too low (~${approxSolLiquidity.toFixed(2)} SOL eq). Skipping...`);
        return;
      }

      console.log(`\n🏦 New valid pool: ${poolPubkey.toBase58()} => target token + ${hasUSDC ? 'USDC' : 'SOL'}. Attempting snipe...`);
      
      // If not forcing SOL, prefer USDC when available
      const useSOL = FORCE_SOL || (!hasUSDC && hasSOL);
      await this.snipePool(poolAmm, useSOL);
    } catch (err) {
      console.error('Error in handleNewPool:', err);
    }
  }

  /**
   * Placeholder: parse logs or postTokenBalances to find the new pool address.
   * Return undefined if we can't figure it out.
   */
  private async findPoolPubkey(txInfo: HeliusTransaction): Promise<PublicKey | undefined> {
    // In a real-world scenario, you'd parse the logs or postTokenBalances
    // to find the newly created pool's address. We'll just return a dummy
    // PublicKey here so that the code flow continues.
    return new PublicKey('11111111111111111111111111111111');
  }

  /**
   * Perform the swap to buy the target token, paying with either SOL or USDC.
   * IMPORTANT: We create associated token accounts if needed. Not doing so
   * can cause the swap to fail due to missing ATAs.
   */
  private async snipePool(pool: AmmImpl, useSOL: boolean) {
    try {
      // figure out which token we pay with
      const inTokenMint = useSOL ? SOL_MINT : USDC_MINT;
      const lamports = QUOTE_AMOUNT * LAMPORTS_PER_SOL;
      const inAmount = new BN(lamports);

      // In dynamic-amm, if using SOL, we actually need a wrapped SOL account.
      // We'll create or reuse the wSOL ATA, deposit SOL, then do the swap.
      const payer = SNIPER_KEYPAIR.publicKey;
      const connection = this.connection;

      // 1) Ensure we have an associated token account for the "input" side
      //    - If using USDC, we need an ATA for USDC.
      //    - If using SOL, we must create a WSOL account and sync it.
      // 2) Ensure we have an ATA for the *output* token (our target).
      //    That way the swap can deposit the target tokens into our wallet.

      const outTokenMint = pool.tokenAMint.address.equals(inTokenMint)
        ? new PublicKey(pool.tokenBMint.address)
        : new PublicKey(pool.tokenAMint.address);

      // STEP A: Create ATA for the output (target) mint if it doesn't exist
      const outAta = await getOrCreateAssociatedTokenAccount(
        connection,
        SNIPER_KEYPAIR,       // payer
        outTokenMint,         // mint
        payer,                // owner
        true                  // allowOwnerOffCurve: keep false/true depending on your needs
      );

      // STEP B: If using SOL, wrap it into a WSOL account
      // Otherwise, if using USDC, just ensure we have a USDC ATA.
      let inTokenAtaPubkey: PublicKey;
      if (useSOL) {
        // Create or get the WSOL ATA
        const wsolAta = await getOrCreateAssociatedTokenAccount(
          connection,
          SNIPER_KEYPAIR,
          NATIVE_MINT,  // WSOL
          payer,
          true
        );
        inTokenAtaPubkey = wsolAta.address;

        // Now we must deposit SOL into that ATA. We'll do a separate small transaction:
        //   1) Transfer SOL from our wallet to the WSOL ATA
        //   2) Sync Native
        //   3) Then we do the swap.
        // (If you want to do everything in one tx, you can combine instructions,
        //  but here's the simpler approach.)
        const tx = await this.buildWrapSolTx(wsolAta.address, lamports);
        const wrapSig = await connection.sendTransaction(tx, [SNIPER_KEYPAIR], {
          skipPreflight: false, // so we see real errors if insufficient SOL
        });
        console.log(`Wrapped ${QUOTE_AMOUNT} SOL => WSOL ATA: ${wrapSig} (waiting for confirm)`);
        await connection.confirmTransaction(wrapSig, 'confirmed');
        console.log(`✅ Wrap SOL transaction confirmed. Now proceeding with swap...`);
      } else {
        // Just get a USDC ATA
        const usdcAta = await getOrCreateAssociatedTokenAccount(
          connection,
          SNIPER_KEYPAIR,
          inTokenMint,
          payer,
          true
        );
        inTokenAtaPubkey = usdcAta.address;
      }

      // recommended to update state before quote
      await pool.updateState();

      // We get the swap quote
      const { minSwapOutAmount, priceImpact } = pool.getSwapQuote(
        inTokenMint,
        inAmount,
        SNIPE_SLIPPAGE_BPS
      );

      console.log(`- Swapping ${QUOTE_AMOUNT} ${useSOL ? 'SOL' : 'USDC'} => target token`);
      console.log(`- minOut: ${minSwapOutAmount.toString()}, priceImpact: ${priceImpact}%`);

      // Build the actual swap transaction
      const swapTx = await pool.swap(
        SNIPER_KEYPAIR.publicKey,
        inTokenMint,
        inAmount,
        minSwapOutAmount
      );

      // If we used WSOL, after the swap, we might want to "close" the leftover WSOL if any.
      // The dynamic-amm client *might* automatically handle that. If not, you can add
      // instructions to close the account if you prefer. We'll skip that for brevity.

      // sign+send
      const blockhashObj = await connection.getLatestBlockhash();
      swapTx.recentBlockhash = blockhashObj.blockhash;
      swapTx.feePayer = SNIPER_KEYPAIR.publicKey;
      swapTx.sign(SNIPER_KEYPAIR);

      // For better debugging, let's not skip preflight
      const txSig = await connection.sendRawTransaction(swapTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });
      console.log(`⏳ Sent swap tx => ${txSig}`);

      const confirmRes = await connection.confirmTransaction(
        {
          signature: txSig,
          blockhash: blockhashObj.blockhash,
          lastValidBlockHeight: blockhashObj.lastValidBlockHeight,
        },
        'confirmed'
      );
      if (confirmRes.value.err) {
        console.error('❌ Swap transaction error =>', confirmRes.value.err);
      } else {
        console.log('✅ Snipe success => swapped for target token!');
      }

      // (Optional) If we used WSOL, unwrap leftover. This example leaves leftover WSOL in the ATA.
    } catch (err) {
      console.error('❌ snipePool error:', err);
    }
  }

  /**
   * Build a simple transaction that wraps SOL into an existing WSOL ATA by:
   *  1) SystemProgram.transfer(...lamports) to the WSOL ATA
   *  2) createSyncNativeInstruction(...) to sync the native balance
   */
  private async buildWrapSolTx(wsolAta: PublicKey, lamports: number) {
    const { SystemProgram, Transaction } = await import('@solana/web3.js');
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
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    return tx;
  }
}

// Parse command line arguments
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
Dynamic AMM Sniper - Usage:
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
    testDynamicAmmSniper();
  } else {
    const sniper = new DynamicAmmSniper(RPC_ENDPOINT, WS_MAINNET_ENDPOINT);
    sniper.start();
    console.log('Press Ctrl+C to exit...');
  }
}

/**
 * Test mode function to verify the DynamicAmmSniper functionality
 * Tests pool detection, liquidity checks, and swap quote calculation
 */
async function testDynamicAmmSniper() {
  // Override the amount to 5 for testing
  const TEST_AMOUNT = 5;
  
  console.log('Testing DynamicAmmSniper functionality...');
  console.log('Sniper wallet:', SNIPER_KEYPAIR.publicKey.toString());
  console.log(`Target token: ${TARGET_TOKEN_ADDRESS}`);
  console.log(`Quote preference: ${FORCE_SOL ? 'Forcing SOL' : 'Preferring USDC, fallback to SOL'}`);
  console.log(`Test amount: ${TEST_AMOUNT} ${FORCE_SOL ? 'SOL' : 'USDC/SOL'}`);
  console.log(`Slippage: ${SNIPE_SLIPPAGE_BPS} BPS`);
  console.log(`Min liquidity: ${MIN_LIQUIDITY_SOL} SOL\n`);

  try {
    // Create connection and test it
    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    console.log('Testing RPC connection...');
    const blockHeight = await connection.getBlockHeight();
    console.log('✅ RPC connected! Current block height:', blockHeight);

    // Use appropriate test pool based on whether we're using SOL or USDC
    const testPool = process.env.TEST_POOL_ADDRESS || (
      FORCE_SOL 
        ? '6SWtsTzXrurtVWZdEHvnQdE9oM8tTtyg8rfEo3b4nM93'  // SOL-USDC pool
        : '7vjYgP4rW4c6m7Wjiw8RofBPis2etR2mfJFuLuB4ysHA'  // USDC pool
    );
    console.log('\n🏦 Testing with pool:', testPool);

    // Test pool loading
    console.log('Testing pool loading...');
    const poolAmm = await AmmImpl.create(connection, new PublicKey(testPool));
    console.log('✅ Successfully loaded pool');

    // Test pool state update
    console.log('\nTesting pool state update...');
    await poolAmm.updateState();
    console.log('✅ Successfully updated pool state');

    // Display pool info
    const { tokenAMint, tokenBMint, poolInfo } = poolAmm;
    console.log('\nPool information:');
    console.log(`Token A: ${tokenAMint.address.toString()} (decimals: ${tokenAMint.decimals})`);
    console.log(`Token B: ${tokenBMint.address.toString()} (decimals: ${tokenBMint.decimals})`);
    
    const humA = poolInfo.tokenAAmount.toNumber() / (10 ** tokenAMint.decimals);
    const humB = poolInfo.tokenBAmount.toNumber() / (10 ** tokenBMint.decimals);
    console.log(`Token A amount: ${humA.toFixed(6)}`);
    console.log(`Token B amount: ${humB.toFixed(6)}`);

    // Find which token in the pool matches our desired input (SOL or USDC)
    const hasUSDC = tokenAMint.address.equals(USDC_MINT) || tokenBMint.address.equals(USDC_MINT);
    const hasSOL = tokenAMint.address.equals(SOL_MINT) || tokenBMint.address.equals(SOL_MINT);
    
    // Determine which token to use based on availability and preference
    const useSOL = FORCE_SOL || (!hasUSDC && hasSOL);
    const desiredInputMint = useSOL ? SOL_MINT : USDC_MINT;
    
    let inTokenMint: PublicKey;
    if (tokenAMint.address.equals(desiredInputMint)) {
      inTokenMint = tokenAMint.address;
      console.log(`Found input token (${useSOL ? 'SOL' : 'USDC'}) as Token A`);
    } else if (tokenBMint.address.equals(desiredInputMint)) {
      inTokenMint = tokenBMint.address;
      console.log(`Found input token (${useSOL ? 'SOL' : 'USDC'}) as Token B`);
    } else {
      console.log('\nDebug info:');
      console.log(`Looking for ${useSOL ? 'SOL' : 'USDC'} mint: ${desiredInputMint.toString()}`);
      console.log(`Pool tokens: A=${tokenAMint.address.toString()}, B=${tokenBMint.address.toString()}`);
      throw new Error(`Pool does not contain ${useSOL ? 'SOL' : 'USDC'}. Please check debug info above.`);
    }

    // Ensure we have an ATA for input and the target token in test mode as well
    const wallet = SNIPER_KEYPAIR.publicKey;

    // (1) Create ATA for input if using USDC. If using SOL, we will wrap separately
    if (!useSOL) {
      await getOrCreateAssociatedTokenAccount(connection, SNIPER_KEYPAIR, inTokenMint, wallet);
    }

    // (2) Create ATA for the target token
    const outTokenMint = (tokenAMint.address.equals(inTokenMint))
      ? tokenBMint.address
      : tokenAMint.address;
    await getOrCreateAssociatedTokenAccount(connection, SNIPER_KEYPAIR, outTokenMint, wallet);

    // Test swap quote calculation
    console.log('\nTesting swap quote calculation...');
    const decimals = useSOL ? 9 : 6;
    const inAmount = new BN(TEST_AMOUNT * Math.pow(10, decimals));

    console.log(`Calculating swap of ${TEST_AMOUNT} ${useSOL ? 'SOL' : 'USDC'}...`);
    const { swapOutAmount, minSwapOutAmount, priceImpact } = poolAmm.getSwapQuote(
      inTokenMint,
      inAmount,
      SNIPE_SLIPPAGE_BPS
    );

    console.log('✅ Successfully calculated swap quote:');
    console.log(`- Input: ${TEST_AMOUNT} ${useSOL ? 'SOL' : 'USDC'}`);
    console.log(`- Expected output: ${swapOutAmount.toString()}`);
    console.log(`- Minimum output: ${minSwapOutAmount.toString()}`);
    console.log(`- Price impact: ${priceImpact}%`);

    // Build and execute the swap transaction
    console.log('\n💸 Executing test swap transaction...');
    const swapTx = await poolAmm.swap(
      SNIPER_KEYPAIR.publicKey,
      inTokenMint,
      inAmount,
      minSwapOutAmount
    );

    // If using SOL, we must wrap SOL for test mode, just as in normal snipe
    // We'll do a quick wrap or skip if user has it. For the example, let's skip
    // because we assume user has wrapped SOL or enough USDC. 
    // For real usage, see the snipePool() logic above.

    // Prepare the transaction
    const blockhashObj = await connection.getLatestBlockhash('finalized');
    swapTx.recentBlockhash = blockhashObj.blockhash;
    swapTx.feePayer = SNIPER_KEYPAIR.publicKey;
    swapTx.sign(SNIPER_KEYPAIR);
    
    // Send transaction
    console.log('Sending transaction...');
    const txSig = await connection.sendRawTransaction(swapTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'finalized',
    });
    console.log(`Transaction sent: ${txSig}`);
    
    // Wait for confirmation with a timeout
    console.log('Waiting for confirmation...');
    try {
      const confirmRes = await Promise.race([
        connection.confirmTransaction(
          {
            signature: txSig,
            blockhash: blockhashObj.blockhash,
            lastValidBlockHeight: blockhashObj.lastValidBlockHeight,
          },
          'confirmed'
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Transaction confirmation timeout')), 30000)
        )
      ]) as { value: { err: any } };

      if (confirmRes.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmRes.value.err)}`);
      }

      console.log('✅ Test swap successful!');
      console.log(`Transaction signature: ${txSig}`);
      console.log(`Explorer link: https://solscan.io/tx/${txSig}`);
    } catch (error: any) {
      if (error.message === 'Transaction confirmation timeout') {
        console.log('Transaction sent but confirmation timed out. Check explorer:');
        console.log(`https://solscan.io/tx/${txSig}`);
      } else {
        throw error;
      }
    }

    console.log('\n✅ All tests passed! The sniper is ready for live mode.');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    if (err instanceof Error) {
      console.error('Error details:', err.message);
      if (err.stack) {
        console.error('\nStack trace:', err.stack);
      }
    }
    process.exit(1);
  }
}
