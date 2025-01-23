/**
 * dlmm-any-sniper.ts
 * 
 * Purpose:
 *  - Connect to the Helius 'atlas' WebSocket endpoint
 *  - Listen for new pool creation events
 *  - Get pool token information
 *  - Attempt to swap for the non-SOL/USDC token using either SOL or USDC
 */

import 'dotenv/config';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, PublicKey } from "@solana/web3.js";
import { getTokensMintFromPoolAddress } from "@meteora-ag/dlmm";
import { flexSwap } from "./Pool/swap";  // Import the new flexSwap function

// Create log file path
const LOG_FILE = path.join(__dirname, 'dlmm-any-sniper.log');

// Constants
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'CHANGE_ME';
const WS_ENDPOINT = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const RPC_ENDPOINT = `https://api.mainnet-beta.solana.com`;
const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// Known token addresses
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Swap configuration
const SWAP_AMOUNT_SOL = 0.1;  // Amount of SOL to swap
const SWAP_AMOUNT_USDC = 10;  // Amount of USDC to swap

function logToFile(message: string) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logMessage);
}

function checkForPoolCreation(logMessages: string[]): boolean {
    return logMessages.some(log => 
        log.toLowerCase().includes('instruction: initializelbpair') ||
        log.toLowerCase().includes('instruction: initialize_lb_pair')
    );
}

async function attemptSwap(
    tokenAddress: string, 
    tokenInfo: {tokenXMint: PublicKey, tokenYMint: PublicKey}
) {
    try {
        console.log(`\n🔄 Attempting swap for token: ${tokenAddress}`);
        logToFile(`\n🔄 Attempting swap for token: ${tokenAddress}`);

        // Check if pool has USDC
        const hasUsdc = tokenInfo.tokenXMint.toString() === USDC || 
                       tokenInfo.tokenYMint.toString() === USDC;
        
        if (hasUsdc) {
            // Use USDC for swap
            console.log('💵 Using USDC for swap...');
            logToFile('💵 Using USDC for swap...');
            await flexSwap(tokenAddress, SWAP_AMOUNT_USDC, true);
        } else {
            // Use SOL for swap
            console.log('◎ Using SOL for swap...');
            logToFile('◎ Using SOL for swap...');
            await flexSwap(tokenAddress, SWAP_AMOUNT_SOL, false);
        }
        
        console.log(`✅ Swap attempted successfully`);
        logToFile(`✅ Swap attempted successfully`);
    } catch (err) {
        console.error('❌ Swap failed:', err);
        logToFile(`❌ Swap failed: ${err}`);
    }
}

async function waitForTokenInfo(poolAddress: string): Promise<{tokenXMint: PublicKey, tokenYMint: PublicKey} | null> {
    let retries = 8;
    let delay = 2000;
    const connection = new Connection(RPC_ENDPOINT);

    while (retries > 0) {
        try {
            console.log(`Attempt ${9 - retries}/8: Fetching pool info...`);
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

            return tokenInfo;
        } catch (err) {
            retries--;
            if (retries > 0) {
                console.log(`Retrying token info fetch in ${delay/1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5;
            } else {
                console.error('Failed to get token info:', err);
                logToFile('Failed to get token info: ' + err);
                return null;
            }
        }
    }
    return null;
}

function getTokenToSwap(tokenX: string, tokenY: string): string | null {
    // If one token is SOL/USDC, return the other token
    if (tokenX === WSOL || tokenX === USDC) {
        return tokenY;
    }
    if (tokenY === WSOL || tokenY === USDC) {
        return tokenX;
    }
    
    // If neither is SOL/USDC, return null
    console.log('⚠️ Neither token is SOL or USDC');
    logToFile('⚠️ Neither token is SOL or USDC');
    return null;
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
        const accountKeys = transaction.transaction.message.accountKeys;
        const poolAccount = accountKeys.find((account: { writable: boolean; pubkey: string }) => 
            account.writable && account.pubkey !== DLMM_PROGRAM_ID.toString()
        );

        if (!poolAccount) {
            console.log('⚠️ Could not find pool address');
            logToFile('⚠️ Could not find pool address');
            return;
        }

        const poolAddress = poolAccount.pubkey;
        console.log('\nPool Address:', poolAddress);
        logToFile('\nPool Address: ' + poolAddress);

        // Get token information
        const tokenInfo = await waitForTokenInfo(poolAddress);
        if (!tokenInfo) return;

        // Determine which token to swap for
        const tokenToSwap = getTokenToSwap(
            tokenInfo.tokenXMint.toString(),
            tokenInfo.tokenYMint.toString()
        );

        if (tokenToSwap) {
            console.log(`\n🎯 Found swappable token: ${tokenToSwap}`);
            logToFile(`\n🎯 Found swappable token: ${tokenToSwap}`);
            
            // Attempt the swap with token info for USDC/SOL detection
            await attemptSwap(tokenToSwap, tokenInfo);
        }
        
        // Log complete transaction details
        console.log('\nDetailed Pool Creation Logs:');
        logToFile('\nDetailed Pool Creation Logs:');
        
        logMessages.forEach((log: string) => {
            console.log('  ', log);
            logToFile('   ' + log);
        });
    } catch (err) {
        console.error('Error in extractPoolDetails:', err);
        logToFile('Error in extractPoolDetails: ' + err);
    }
}

function main() {
    console.log('=========================');
    console.log('DLMM POOL SNIPER');
    console.log('=========================');
    console.log(`WebSocket URL: ${WS_ENDPOINT}`);
    console.log(`Program ID: ${DLMM_PROGRAM_ID.toString()}\n`);
    console.log('🔍 Watching for new pools...\n');
    
    logToFile('=========================');
    logToFile('DLMM POOL SNIPER');
    logToFile('=========================');
    logToFile(`WebSocket URL: ${WS_ENDPOINT}`);
    logToFile(`Program ID: ${DLMM_PROGRAM_ID.toString()}\n`);
    logToFile('🔍 Watching for new pools...\n');

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
        console.log('Subscription request sent. Watching for new pools...');
        logToFile('Subscription request sent. Watching for new pools...');
    });

    ws.on('message', async (rawData: any) => {
        if (foundPool) return;

        try {
            messageCount++;
            const dataStr = rawData.toString();
            console.log(`\n[MSG #${messageCount}] Received new transaction`);
            logToFile(`\n[MSG #${messageCount}] Received new transaction`);

            const msg = JSON.parse(dataStr);

            if (!msg.params?.result) {
                return;
            }

            const { signature, transaction } = msg.params.result;
            
            if (transaction.meta.logMessages) {
                if (!foundPool && checkForPoolCreation(transaction.meta.logMessages)) {
                    foundPool = true;
                    try {
                        await extractPoolDetails(transaction, signature);
                    } finally {
                        console.log('\n📝 Pool processed - Stopping execution');
                        logToFile('\n📝 Pool processed - Stopping execution');
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
    fs.writeFileSync(LOG_FILE, ''); // Clear log file
    main();
}