/**
 * dlmm-test-lbPair2.ts
 *
 * Purpose:
 *  - Connect to the Helius 'atlas' WebSocket endpoint (which supports transactionSubscribe).
 *  - Listen for transactions from the Meteora DLMM (LBCLMM) program ID.
 *  - Print out verbose logs for each transaction.
 *  - Detect and log pool creation events with token information, then exit.
 *
 * Usage:
 *   npx ts-node src/meteora/dlmm-test-lbPair2.ts
 */

import 'dotenv/config';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { 
    Connection, 
    PublicKey, 
    Transaction, 
    TransactionInstruction,
    LAMPORTS_PER_SOL 
} from "@solana/web3.js";
import { getTokensMintFromPoolAddress } from "@meteora-ag/dlmm";

// Create log file path
const LOG_FILE = path.join(__dirname, 'dlmm-lbPair2.log');

// Constants
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'CHANGE_ME';
const WS_ENDPOINT = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const RPC_ENDPOINT = `https://api.mainnet-beta.solana.com`; // For fetching pool data
const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// File logging utility function
function logToFile(message: string) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logMessage);
}

function checkForPoolCreation(logMessages: string[]): boolean {
    return logMessages.some((log: string) => 
        log.toLowerCase().includes('instruction: initializelbpair') ||
        log.toLowerCase().includes('instruction: initialize_lb_pair')
    );
}

function findPoolAddress(transaction: any, logMessages: string[]): string | undefined {
    try {
        // Get all account keys from the transaction
        const accountKeys = transaction.transaction.message.accountKeys || [];
        
        // Find the index where InitializeLbPair is called
        const initIndex = logMessages.findIndex((log: string) => 
            log.includes('Instruction: InitializeLbPair')
        );

        if (initIndex === -1) return undefined;

        // Look at the accounts used in this instruction
        const accounts = accountKeys
            .filter((acc: { signer: boolean; writable: boolean; pubkey: string }) => acc.signer === false && acc.writable === true)
            .map((acc: { pubkey: string }) => acc.pubkey)
            .filter((pubkey: string) => pubkey !== DLMM_PROGRAM_ID.toString());

        // The pool address should be the first non-program writable account
        return accounts[0];

    } catch (err) {
        console.error('Error finding pool address:', err);
        return undefined;
    }
}

async function waitForTokenInfo(poolAddress: string, maxRetries = 8): Promise<void> {
    let retries = maxRetries;
    let delay = 2000; // Start with 2 second delay
    const connection = new Connection(RPC_ENDPOINT);

    while (retries > 0) {
        try {
            console.log(`Attempt ${maxRetries - retries + 1}/${maxRetries}: Fetching pool info...`);
            const tokenInfo = await getTokensMintFromPoolAddress(
                connection, 
                poolAddress,
                { cluster: 'mainnet-beta' }
            );
            
            console.log('\nPool Token Information:');
            console.log('Token X Mint:', tokenInfo.tokenXMint.toString());
            console.log('Token Y Mint:', tokenInfo.tokenYMint.toString());
            
            logToFile('\nPool Token Information:');
            logToFile('Token X Mint: ' + tokenInfo.tokenXMint.toString());
            logToFile('Token Y Mint: ' + tokenInfo.tokenYMint.toString());
            return;
        } catch (err) {
            retries--;
            if (retries > 0) {
                console.log(`Retrying token info fetch in ${delay/1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5; // Increase delay by 50% each retry
            } else {
                throw err;
            }
        }
    }
}

async function extractPoolDetails(transaction: any, signature: string) {
    try {
        console.log('\n🎉 🎊 NEW POOL CREATION DETECTED! 🎊 🎉');
        logToFile('\n🎉 🎊 NEW POOL CREATION DETECTED! 🎊 🎉');
        
        console.log('=====================================');
        logToFile('=====================================');
        
        console.log('Transaction Signature:', signature);
        logToFile('Transaction Signature: ' + signature);

        const logMessages = transaction.meta.logMessages || [];
        
        // Find pool address from transaction data
        const poolAddress = findPoolAddress(transaction, logMessages);

        if (poolAddress) {
            console.log('\nPool Address:', poolAddress);
            logToFile('\nPool Address: ' + poolAddress);

            try {
                await waitForTokenInfo(poolAddress);
            } catch (err) {
                console.error('Error fetching pool token information:', err);
                logToFile('Error fetching pool token information: ' + err);
                console.log('\nNote: Pool info may take a few minutes to be available on-chain');
                logToFile('\nNote: Pool info may take a few minutes to be available on-chain');
            }
        } else {
            console.log('\n⚠️ Could not find pool address in transaction');
            logToFile('\n⚠️ Could not find pool address in transaction');
        }
        
        console.log('\nDetailed Pool Creation Logs:');
        logToFile('\nDetailed Pool Creation Logs:');
        
        logMessages.forEach((log: string) => {
            console.log('  ', log);
            logToFile('   ' + log);
        });
        
        if (transaction.meta.preTokenBalances?.length > 0) {
            console.log('\nToken Balances:');
            logToFile('\nToken Balances:');
            
            transaction.meta.preTokenBalances.forEach((balance: any) => {
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
    } catch (err) {
        console.error('Error in extractPoolDetails:', err);
        logToFile('Error in extractPoolDetails: ' + err);
    }
}

function main() {
    console.log('=========================');
    console.log('DLMM PROGRAM ID TEST LOGS');
    console.log('=========================');
    console.log(`WebSocket URL: ${WS_ENDPOINT}`);
    console.log(`Program ID: ${DLMM_PROGRAM_ID.toString()}\n`);
    console.log('🔍 Watching specifically for pool creation events (initializeLbPair)...\n');
    
    logToFile('=========================');
    logToFile('DLMM PROGRAM ID TEST LOGS');
    logToFile('=========================');
    logToFile(`WebSocket URL: ${WS_ENDPOINT}`);
    logToFile(`Program ID: ${DLMM_PROGRAM_ID.toString()}\n`);
    logToFile('🔍 Watching specifically for pool creation events (initializeLbPair)...\n');

    let messageCount = 0;
    let foundPool = false;
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
                    accountInclude: [DLMM_PROGRAM_ID.toString()],
                    failed: false,
                },
                {
                    commitment: 'confirmed',
                    encoding: 'jsonParsed',
                    transactionDetails: 'full',
                    maxSupportedTransactionVersion: 0
                }
            ]
        };

        ws.send(JSON.stringify(subscription));
        console.log('Subscription request sent. Watching for pool creation...');
        logToFile('Subscription request sent. Watching for pool creation...');
    });

    ws.on('message', async (rawData: any) => {
        if (foundPool) return; // Skip if we've already found a pool

        try {
            messageCount++;
            const dataStr = rawData.toString();
            console.log(`\n[MSG #${messageCount}] Raw data:`, dataStr);
            logToFile(`\n[MSG #${messageCount}] Raw data: ${dataStr}`);

            const msg = JSON.parse(dataStr);

            if (!msg.params?.result) {
                console.log('No transaction data in this message');
                return;
            }

            const { signature, transaction } = msg.params.result;
            console.log('------------------------------------');
            console.log(`New transaction referencing LBCLMM => Sig: ${signature}`);
            
            logToFile('------------------------------------');
            logToFile(`New transaction referencing LBCLMM => Sig: ${signature}`);

            if (transaction.meta.logMessages) {
                console.log('\nLogs:');
                logToFile('\nLogs:');
                
                for (const log of transaction.meta.logMessages) {
                    console.log('  ', log);
                    logToFile('   ' + log);
                }

                if (!foundPool && checkForPoolCreation(transaction.meta.logMessages)) {
                    foundPool = true;
                    try {
                        await extractPoolDetails(transaction, signature);
                    } finally {
                        console.log('\n📝 Pool Creation Transaction Found - Stopping Execution');
                        logToFile('\n📝 Pool Creation Transaction Found - Stopping Execution');
                        ws.close();
                        process.exit(0);
                    }
                }
            }
        } catch (err) {
            console.error('Error processing message =>', err);
            logToFile('Error processing message => ' + err);
        }
    });

    ws.on('close', () => {
        if (!foundPool) {
            console.error(`WebSocket closed after ${messageCount} messages. Reconnecting in 5s...`);
            logToFile(`WebSocket closed after ${messageCount} messages. Reconnecting in 5s...`);
            setTimeout(() => main(), 5000);
        }
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