/**
 * dlmm_program_id_test.ts
 *
 * Purpose:
 *  - Connect to the Helius 'atlas' WebSocket endpoint (which supports transactionSubscribe).
 *  - Listen for transactions from the Meteora DLMM (LBCLMM) program ID.
 *  - Print out verbose logs for each transaction.
 *  - Detect and log pool creation events (initializeLbPair), then exit.
 *  - Once we detect the instruction, we parse the newly created pool's public key, load its
 *    lbPair account from chain using the anchor Program + your full IDL, print out the
 *    token X/Y mint, and exit.
 *
 * Usage:
 *   npx ts-node src/meteora/dlmm_program_id_test.ts
 */

import 'dotenv/config';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

import {
  AnchorProvider,
  Program,
} from '@coral-xyz/anchor';
import {
  Connection,
  PublicKey,
  Cluster,
} from '@solana/web3.js';

// ---- IMPORTANT: 
// We import the full IDL from your local src/meteora/idl.ts
import { IDL } from './idl';  // adjust path if needed

//////////////////////////////////////////////////////////////////////////////////
// Program ID (DLMM on mainnet) and Endpoint
//////////////////////////////////////////////////////////////////////////////////

// The official LB CLMM (DLMM) program ID on mainnet
const LBCLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

/**
 * The aggregator endpoint for Helius that supports "transactionSubscribe".
 * (We are using the atlas endpoint in this example.)
 */
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'CHANGE_ME';
const WS_ENDPOINT = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

//////////////////////////////////////////////////////////////////////////////////
// IDL Type
//////////////////////////////////////////////////////////////////////////////////

/** 
 * Because you have a big IDL, the type might be something like:
 * type LbClmmIdl = typeof IDL;
 * 
 * We'll just assume 'typeof IDL' is correct here.
 */
type LbClmmIdl = typeof IDL;

//////////////////////////////////////////////////////////////////////////////////
// Logging setup
//////////////////////////////////////////////////////////////////////////////////

// Create or reuse a log file path
const LOG_FILE = path.join(__dirname, 'dlmm-pool-creation.log');

// File logging utility function
function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logMessage);
}

//////////////////////////////////////////////////////////////////////////////////
// Minimal shape for Helius transaction subscribe
//////////////////////////////////////////////////////////////////////////////////

interface TransactionNotifyMessage {
  jsonrpc: string;
  method: string;
  error?: {
    code: number;
    message: string;
  };
  params?: {
    result: {
      signature: string;
      transaction: {
        meta: {
          err: any;
          logMessages?: string[];
          preTokenBalances?: any[];
          postTokenBalances?: any[];
        };
        transaction: {
          message: {
            instructions: Array<{
              programId: string;
              data: string;
              accounts: string[];
            }>;
          };
        };
      };
    };
    subscription: number;
  };
  id?: string | number;
}

//////////////////////////////////////////////////////////////////////////////////
// Check for "Instruction: initializeLbPair" in logs (case-insensitive)
//////////////////////////////////////////////////////////////////////////////////

function checkForPoolCreation(logMessages: string[]): boolean {
  return logMessages.some(log =>
    log.toLowerCase().includes('instruction: initializelbpair') ||
    log.toLowerCase().includes('instruction: initialize_lb_pair')
  );
}

//////////////////////////////////////////////////////////////////////////////////
// Attempt to parse the newly created pool address
// from the instruction's account arrays or logs.
//////////////////////////////////////////////////////////////////////////////////

function parsePoolAddressFromInstruction(txInfo: any): string | null {
  if (!txInfo?.transaction?.message?.instructions) return null;

  // Locate the instruction referencing LBCLMM_PROGRAM_ID
  const lbIx = txInfo.transaction.message.instructions.find(
    (ix: any) => ix.programId === LBCLMM_PROGRAM_ID.toBase58()
  );
  if (!lbIx) return null;

  // Suppose the newly created LB pair is the first account in that instruction
  if (lbIx.accounts && lbIx.accounts.length > 0) {
    return lbIx.accounts[0];
  }

  return null;
}

//////////////////////////////////////////////////////////////////////////////////
// Load the tokenXMint and tokenYMint from the newly created lbPair
// using your full IDL
//////////////////////////////////////////////////////////////////////////////////

async function getTokensMintFromPoolAddress(
  connection: Connection,
  poolAddr: string,
  cluster?: Cluster
): Promise<{ tokenXMint: PublicKey; tokenYMint: PublicKey }> {

  // Set up an AnchorProvider with your connection
  const provider = new AnchorProvider(connection, {} as any, AnchorProvider.defaultOptions());
  // Create a Program instance from your full IDL
  const program = new Program<LbClmmIdl>(
    IDL as any, 
    LBCLMM_PROGRAM_ID,
    provider
  );

  // Fetch the lbPair account
  const lbPairAccount = await program.account.lbPair.fetchNullable(new PublicKey(poolAddr));
  if (!lbPairAccount) {
    throw new Error(`lbPair account not found at ${poolAddr}`);
  }

  // The IDL defines tokenXMint and tokenYMint on the lbPair account
  const tokenXMint = lbPairAccount.tokenXMint as PublicKey;
  const tokenYMint = lbPairAccount.tokenYMint as PublicKey;
  
  return { tokenXMint, tokenYMint };
}

//////////////////////////////////////////////////////////////////////////////////
// The main logic
//////////////////////////////////////////////////////////////////////////////////

function main() {
  console.log('=========================');
  console.log('DLMM PROGRAM ID TEST LOGS');
  console.log('=========================');
  console.log(`WebSocket URL: ${WS_ENDPOINT}`);
  console.log(`Program ID: ${LBCLMM_PROGRAM_ID.toBase58()}\n`);
  console.log('🔍 Watching specifically for pool creation events (initializeLbPair)...\n');

  // Clear out the log file at the start
  fs.writeFileSync(LOG_FILE, '');

  logToFile('=========================');
  logToFile('DLMM PROGRAM ID TEST LOGS');
  logToFile('=========================');
  logToFile(`WebSocket URL: ${WS_ENDPOINT}`);
  logToFile(`Program ID: ${LBCLMM_PROGRAM_ID.toBase58()}`);
  logToFile('🔍 Watching for "initializeLbPair"...\n');

  let messageCount = 0;
  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const ws = new WebSocket(WS_ENDPOINT);

  ws.on('open', () => {
    console.log('WebSocket connected to Helius (atlas). Subscribing to DLMM transactions...\n');
    logToFile('WebSocket connected. Subscribing to DLMM transactions...');

    const subscription = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        {
          accountInclude: [LBCLMM_PROGRAM_ID.toBase58()],
          failed: false
        },
        {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
          transactionDetails: 'full'
        }
      ]
    };

    ws.send(JSON.stringify(subscription));
    console.log('Subscription request sent. Watching for pool creation...');
    logToFile('Subscription request sent. Watching for "initializeLbPair"...');
  });

  ws.on('message', async (rawData: any) => {
    try {
      messageCount++;
      const rawStr = rawData.toString();
      console.log(`\n[MSG #${messageCount}] Raw data:`, rawStr);
      logToFile(`[MSG #${messageCount}] Raw data: ${rawStr}`);

      const msg: TransactionNotifyMessage = JSON.parse(rawStr);

      // Check for top-level error
      if (msg.error) {
        console.log('❌ Subscription error:', msg.error);
        logToFile('❌ Subscription error: ' + JSON.stringify(msg.error));
        return;
      }

      // Not a transaction notification
      if (!msg.params || !msg.params.result) {
        console.log('No transaction data in this message =>', msg);
        logToFile('No transaction data in this message => ' + JSON.stringify(msg));
        return;
      }

      const { signature, transaction } = msg.params.result;
      console.log('------------------------------------');
      console.log(`New transaction referencing LBCLMM => Sig: ${signature}`);
      logToFile('------------------------------------');
      logToFile(`New transaction referencing LBCLMM => Sig: ${signature}`);

      // Print logs
      if (transaction.meta.logMessages) {
        console.log('\nLogs:');
        logToFile('\nLogs:');
        for (const line of transaction.meta.logMessages) {
          console.log('  ', line);
          logToFile('   ' + line);
        }

        // Check if "Instruction: initializeLbPair"
        if (checkForPoolCreation(transaction.meta.logMessages)) {
          console.log('\n🎉 Found "initializeLbPair" in logs! Attempting to parse pool address...');
          logToFile('\n🎉 Found "initializeLbPair" in logs! Attempting to parse pool address...');

          const newPoolAddr = parsePoolAddressFromInstruction(transaction);
          if (!newPoolAddr) {
            console.log('⚠️ Could not parse new LB pair address from instruction. Stopping.');
            logToFile('⚠️ Could not parse new LB pair address from instruction. Stopping.');
            process.exit(0);
          }

          console.log(`Parsed new LB pair => ${newPoolAddr}`);
          logToFile(`Parsed new LB pair => ${newPoolAddr}`);

          // Now fetch the lbPair account, see tokenXMint & tokenYMint
          try {
            const { tokenXMint, tokenYMint } = await getTokensMintFromPoolAddress(connection, newPoolAddr);
            console.log(`✅ LB pair tokenXMint => ${tokenXMint.toBase58()}`);
            console.log(`✅ LB pair tokenYMint => ${tokenYMint.toBase58()}`);
            logToFile(`✅ LB pair tokenXMint => ${tokenXMint.toBase58()}`);
            logToFile(`✅ LB pair tokenYMint => ${tokenYMint.toBase58()}`);
          } catch (err) {
            console.log('❌ Error fetching lbPair account =>', err);
            logToFile('❌ Error fetching lbPair account => ' + err);
          }

          console.log('\n🎉 Pool creation event found. Stopping execution now!\n');
          logToFile('\n🎉 Pool creation event found. Stopping execution now!\n');

          ws.close();
          process.exit(0);
        }
      }

      // Token Balances
      if (transaction.meta.preTokenBalances || transaction.meta.postTokenBalances) {
        console.log('\nToken Balances:');
        console.log('Pre:', transaction.meta.preTokenBalances);
        console.log('Post:', transaction.meta.postTokenBalances);

        logToFile('\nToken Balances:');
        logToFile('Pre: ' + JSON.stringify(transaction.meta.preTokenBalances));
        logToFile('Post: ' + JSON.stringify(transaction.meta.postTokenBalances));
      }

      console.log('\nTX Error:', transaction.meta.err ? transaction.meta.err : 'None');
      console.log('------------------------------------\n');

      logToFile('\nTX Error: ' + (transaction.meta.err ? JSON.stringify(transaction.meta.err) : 'None'));
      logToFile('------------------------------------\n');

    } catch (err) {
      console.error('Error processing message =>', err);
      console.error('Raw data =>', rawData.toString());
      logToFile('Error processing message => ' + err);
      logToFile('Raw data => ' + rawData.toString());
    }
  });

  ws.on('close', () => {
    console.error(`WebSocket closed after ${messageCount} messages. Reconnecting in 5s...`);
    logToFile(`WebSocket closed after ${messageCount} messages. Reconnecting in 5s...`);
    setTimeout(() => main(), 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error =>', err);
    logToFile('WebSocket error => ' + err);
  });
}

// If invoked directly
if (require.main === module) {
  main();
}
