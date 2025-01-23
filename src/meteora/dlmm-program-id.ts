import 'dotenv/config';
import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';

// Program ID for the LB CLMM (DLMM) on mainnet
const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

// Network configuration
const NETWORK_ENV = process.env.NETWORK || 'mainnet';
const MAINNET_ENDPOINT = process.env.MAINNET_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const DEVNET_ENDPOINT = process.env.DEVNET_ENDPOINT || 'https://api.devnet.solana.com';

// Choose the appropriate RPC for your environment
const RPC_ENDPOINT = (NETWORK_ENV === 'devnet') ? DEVNET_ENDPOINT : MAINNET_ENDPOINT;

// Helius WebSocket URL (for mainnet) or your devnet alternative
const WS_ENDPOINT = process.env.WS_MAINNET_ENDPOINT
  || 'wss://mainnet.helius-rpc.com/?api-key=e7a0fa4f-35a0-44b0-abcc-67b82875b2df';

// Transaction interface definitions
interface HeliusTransaction {
  meta: {
    err: any;
    fee: number;
    postBalances: number[];
    preBalances: number[];
    postTokenBalances: any[];
    preTokenBalances: any[];
    logMessages: string[];
    innerInstructions: any[];
  };
  transaction: {
    message: {
      accountKeys: string[];
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

class DLMMTransactionMonitor {
  private ws: WebSocket | null = null;
  private connection: Connection;
  private processedTxCount = 0;

  constructor(
    private rpcUrl: string,
    private wsUrl: string
  ) {
    this.connection = new Connection(this.rpcUrl, 'confirmed');
  }

  public start() {
    console.log(`\n==== Meteora DLMM Transaction Monitor ====\n`);
    console.log(`Environment: ${NETWORK_ENV}`);
    console.log(`RPC Endpoint: ${this.rpcUrl}`);
    console.log(`WS Endpoint: ${this.wsUrl}`);
    console.log(`Monitoring DLMM Program ID: ${DLMM_PROGRAM_ID}\n`);

    this.initWs();
  }

  private initWs() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('WebSocket connected. Subscribing to DLMM program transactions...');
      const subscription = {
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [
          {
            accountInclude: [DLMM_PROGRAM_ID],
            // Include both successful and failed transactions
            failed: true,
          },
          {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
            transactionDetails: 'full',
            showLogs: true,
          },
        ],
      };
      this.ws!.send(JSON.stringify(subscription));
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as HeliusRealtimeMessage;
        if (!msg.params || !msg.params.result) return;

        const { transaction, meta, signature } = msg.params.result;
        this.processedTxCount++;

        // Print detailed transaction information
        console.log('\n' + '='.repeat(80));
        console.log(`Transaction #${this.processedTxCount} | Signature: ${signature}`);
        console.log('='.repeat(80));

        // Transaction status
        console.log(`Status: ${meta.err ? 'Failed ❌' : 'Success ✅'}`);
        if (meta.err) {
          console.log(`Error: ${JSON.stringify(meta.err)}`);
        }

        // Fee information
        console.log(`Transaction fee: ${meta.fee / 1e9} SOL`);

        // Instructions
        console.log('\nInstructions:');
        transaction.message.instructions.forEach((ix, index) => {
          console.log(`\n[${index + 1}] Program: ${ix.programId}`);
          if (ix.programId === DLMM_PROGRAM_ID) {
            console.log(`Data (base58): ${ix.data}`);
            console.log(`Accounts involved: ${ix.accounts?.length || 0}`);
            ix.accounts?.forEach((acct, i) => {
              console.log(`  ${i + 1}. ${acct}`);
            });
          }
        });

        // Log messages
        if (meta.logMessages && meta.logMessages.length > 0) {
          console.log('\nProgram Logs:');
          meta.logMessages.forEach((log, i) => {
            if (log.includes(DLMM_PROGRAM_ID)) {
              console.log(`${i + 1}. ${log}`);
            }
          });
        }

        // Token balance changes
        if (meta.postTokenBalances && meta.postTokenBalances.length > 0) {
          console.log('\nToken Balance Changes:');
          meta.postTokenBalances.forEach((balance: any) => {
            console.log(`Account: ${balance.accountIndex}`);
            console.log(`Mint: ${balance.mint}`);
            console.log(`Owner: ${balance.owner}`);
            console.log(`Balance: ${balance.uiTokenAmount.uiAmount}`);
          });
        }

        console.log('\n' + '-'.repeat(80) + '\n');
      } catch (err) {
        console.error('Error processing WS message:', err);
      }
    });

    this.ws.on('close', () => {
      console.error('WebSocket closed. Reconnecting in 5 seconds...');
      setTimeout(() => this.initWs(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
  }
}

// Start the monitor if this file is run directly
if (require.main === module) {
  const monitor = new DLMMTransactionMonitor(RPC_ENDPOINT, WS_ENDPOINT);
  monitor.start();
  console.log('Press Ctrl+C to exit...');
}
