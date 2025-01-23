/**
 * dlmm_program_id_test.ts
 *
 * Purpose:
 *  - Connect to the Helius 'atlas' WebSocket endpoint (which supports transactionSubscribe).
 *  - Listen for transactions from the Meteora DLMM (LBCLMM) program ID.
 *  - Print out verbose logs for each transaction.
 *
 * Usage:
 *   npx ts-node src/meteora/dlmm_program_id_test.ts
 */

import 'dotenv/config';
import WebSocket from 'ws';

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

function main() {
  console.log('=========================');
  console.log('DLMM PROGRAM ID TEST LOGS');
  console.log('=========================');
  console.log(`WebSocket URL: ${WS_ENDPOINT}`);
  console.log(`Program ID: ${DLMM_PROGRAM_ID}\n`);

  let messageCount = 0;
  const ws = new WebSocket(WS_ENDPOINT);

  ws.on('open', () => {
    console.log('WebSocket connected to Helius (atlas). Subscribing to DLMM transactions...\n');

    // 2) "transactionSubscribe" is only recognized on the Atlas aggregator.
    const subscription = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        {
          accountInclude: [DLMM_PROGRAM_ID],
          failed: false, // or true if you want failed tx too
        },
        {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
          transactionDetails: 'full'
        }
      ]
    };

    // Send subscription request
    ws.send(JSON.stringify(subscription));
    console.log('Subscription request sent. Waiting for messages...');
  });

  ws.on('message', (rawData: any) => {
    try {
      messageCount++;
      const dataStr = rawData.toString();
      console.log(`\n[MSG #${messageCount}] Raw data:`, dataStr);

      const msg: TransactionNotifyMessage = JSON.parse(dataStr);

      // Check if there's an error
      if (msg.error) {
        console.log('❌ Subscription error:', msg.error);
        return;
      }

      // If no "params.result" => not a transaction notification
      if (!msg.params || !msg.params.result) {
        console.log('No transaction data in this message =>', msg);
        return;
      }

      // We have a transaction
      const { signature, transaction } = msg.params.result;
      console.log('------------------------------------');
      console.log(`New transaction referencing LBCLMM => Sig: ${signature}`);

      // Print logs
      if (transaction.meta.logMessages) {
        console.log('\nLogs:');
        for (const log of transaction.meta.logMessages) {
          console.log('  ', log);
        }
      }

      // Print token balances
      if (transaction.meta.preTokenBalances || transaction.meta.postTokenBalances) {
        console.log('\nToken Balances:');
        console.log('Pre:', transaction.meta.preTokenBalances);
        console.log('Post:', transaction.meta.postTokenBalances);
      }

      console.log('\nTX Error:', transaction.meta.err ? transaction.meta.err : 'None');
      console.log('------------------------------------\n');
    } catch (err) {
      console.error('Error processing message =>', err);
      console.error('Raw data =>', rawData.toString());
    }
  });

  ws.on('close', () => {
    console.error(`WebSocket closed after ${messageCount} messages. Reconnecting in 5s...`);
    setTimeout(() => main(), 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error =>', err);
  });
}

// If invoked directly
if (require.main === module) {
  main();
}
