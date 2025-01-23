/**
 * dlmm_program_id_test.ts
 *
 * Purpose:
 *  - Connect to the Helius 'atlas' WebSocket endpoint (which supports transactionSubscribe).
 *  - Listen for transactions from the Meteora DLMM (LBCLMM) program ID.
 *  - Print out verbose logs for each transaction.
 *  - Detect and log pool creation events, then exit.
 *
 * Usage:
 *   npx ts-node src/meteora/dlmm_program_id_test.ts
 */

import 'dotenv/config';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

// Create log file path
const LOG_FILE = path.join(__dirname, 'dlmm-pool-creation.log');

// File logging utility function
function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logMessage);
}

// 1) Use your "atlas" or "geyser" WS endpoint from Helius
//    The normal wss://mainnet.helius-rpc.com does NOT support transactionSubscribe.
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'CHANGE_ME';
const WS_ENDPOINT = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// The official LB CLMM (DLMM) program ID on mainnet
const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

// Minimal shape
interface TransactionNotifyMessage {
  jsonrpc: string;
  method: string;
  error?: {
    code: number;
    message: string;
  };
  params: {
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

function checkForPoolCreation(logMessages: string[]): boolean {
  return logMessages.some(log => 
    log.toLowerCase().includes('instruction: initializelbpair') ||
    log.toLowerCase().includes('instruction: initialize_lb_pair')
  );
}

function extractPoolDetails(logMessages: string[], signature: string, tokenBalances: any) {
  console.log('\n🎉 🎊 NEW POOL CREATION DETECTED! 🎊 🎉');
  logToFile('\n🎉 🎊 NEW POOL CREATION DETECTED! 🎊 🎉');
  
  console.log('=====================================');
  logToFile('=====================================');
  
  console.log('Transaction Signature:', signature);
  logToFile('Transaction Signature: ' + signature);
  
  console.log('\nDetailed Pool Creation Logs:');
  logToFile('\nDetailed Pool Creation Logs:');
  
  logMessages.forEach(log => {
    console.log('  ', log);
    logToFile('   ' + log);
  });
  
  if (tokenBalances && tokenBalances.length > 0) {
    console.log('\nToken Information:');
    logToFile('\nToken Information:');
    
    tokenBalances.forEach((balance: any) => {
      if (balance && balance.mint) {
        console.log(`  Mint: ${balance.mint}`);
        console.log(`  Owner: ${balance.owner}`);
        console.log(`  Amount: ${balance.uiTokenAmount.uiAmount}`);
        console.log('  ---');
        
        logToFile(`  Mint: ${balance.mint}`);
        logToFile(`  Owner: ${balance.owner}`);
        logToFile(`  Amount: ${balance.uiTokenAmount.uiAmount}`);
        logToFile('  ---');
      }
    });
  }
  
  console.log('\n📝 Pool Creation Transaction Found - Stopping Execution');
  console.log('=====================================\n');
  
  logToFile('\n📝 Pool Creation Transaction Found - Stopping Execution');
  logToFile('=====================================\n');
}

function main() {
  console.log('=========================');
  console.log('DLMM PROGRAM ID TEST LOGS');
  console.log('=========================');
  console.log(`WebSocket URL: ${WS_ENDPOINT}`);
  console.log(`Program ID: ${DLMM_PROGRAM_ID}\n`);
  console.log('🔍 Watching specifically for pool creation events (initializeLbPair)...\n');
  
  logToFile('=========================');
  logToFile('DLMM PROGRAM ID TEST LOGS');
  logToFile('=========================');
  logToFile(`WebSocket URL: ${WS_ENDPOINT}`);
  logToFile(`Program ID: ${DLMM_PROGRAM_ID}\n`);
  logToFile('🔍 Watching specifically for pool creation events (initializeLbPair)...\n');

  let messageCount = 0;
  const ws = new WebSocket(WS_ENDPOINT);

  ws.on('open', () => {
    console.log('WebSocket connected to Helius (atlas). Subscribing to DLMM transactions...\n');
    logToFile('WebSocket connected to Helius (atlas). Subscribing to DLMM transactions...\n');

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

    ws.send(JSON.stringify(subscription));
    console.log('Subscription request sent. Watching for pool creation...');
    logToFile('Subscription request sent. Watching for pool creation...');
  });

  ws.on('message', (rawData: any) => {
    try {
      messageCount++;
      const dataStr = rawData.toString();
      console.log(`\n[MSG #${messageCount}] Raw data:`, dataStr);
      logToFile(`\n[MSG #${messageCount}] Raw data: ${dataStr}`);

      const msg: TransactionNotifyMessage = JSON.parse(dataStr);

      if (msg.error) {
        console.log('❌ Subscription error:', msg.error);
        logToFile('❌ Subscription error: ' + JSON.stringify(msg.error));
        return;
      }

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
        
        for (const log of transaction.meta.logMessages) {
          console.log('  ', log);
          logToFile('   ' + log);
        }

        // Check for pool creation
        if (checkForPoolCreation(transaction.meta.logMessages)) {
          extractPoolDetails(
            transaction.meta.logMessages,
            signature,
            transaction.meta.preTokenBalances
          );
          
          // Close WebSocket and exit process
          ws.close();
          process.exit(0);
        }
      }

      // Print token balances
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
  // Clear the log file at start
  fs.writeFileSync(LOG_FILE, '');
  main();
}