import WebSocket from 'ws';
import { logger } from './logger';
import { MeteoraSniper } from './sniper';
import { PublicKey } from '@solana/web3.js';
import { sighash } from './utils';

const HELIUS_API_KEY = 'e7a0fa4f-35a0-44b0-abcc-67b82875b2df';
const WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Meteora program ID and your token
const METEORA_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const YOUR_TOKEN = 'B1PZbW2BzgumjapoKtYFrcjj1CMQaYWCcoHvkqeTmvmG';

console.log(`Connecting to Helius WebSocket at ${WS_URL}`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('WebSocket connection established');
    
    // Subscribe to transactions
    const subscribeMsg = {
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [{
            accountInclude: [METEORA_PROGRAM_ID, YOUR_TOKEN], // Monitor Meteora program and your token
            type: 'dex', // This filters for DEX transactions
        }]
    };
    
    console.log('Sending subscription message:', JSON.stringify(subscribeMsg, null, 2));
    ws.send(JSON.stringify(subscribeMsg));
});

ws.on('message', async (data: Buffer) => {
    const message = data.toString();
    console.log('Received message:', message);
    try {
        const parsed = JSON.parse(message);
        if (parsed.error) {
            logger.error('WebSocket error response:', parsed.error);
        } else {
            logger.debug('WebSocket message:', parsed);
            
            // Check if this is a transaction message with logs
            if (parsed.params?.result?.transaction?.meta?.logMessages) {
                const tx = parsed.params.result;
                const logMessages: string[] = tx.transaction.meta.logMessages;
                
                // Check for pool initialization in logs
                const hasInitPool = logMessages.some((log: string) => 
                    log.toLowerCase().includes('instruction: initializelbpair') ||
                    log.toLowerCase().includes('instruction: initialize_lb_pair')
                );

                if (hasInitPool) {
                    const poolMessage = `🎉 🎊 NEW POOL CREATION DETECTED! 🎊 🎉\n` +
                        `=====================================\n` +
                        `Transaction Signature: ${tx.signature}\n\n` +
                        `Detailed Pool Creation Logs:\n${logMessages.map(log => '   ' + log).join('\n')}\n\n` +
                        `=====================================\n`;
                    
                    console.log('\x1b[32m%s\x1b[0m', poolMessage); // Print in green
                    logger.info(poolMessage);
                    
                    // Close the websocket and exit
                    ws.close();
                    process.exit(0);
                }
            }
        }
    } catch (e) {
        logger.error(`Failed to parse message: ${message}`);
    }
});

ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    logger.error(`WebSocket error: ${error.message}`);
});

ws.on('close', () => {
    console.log('WebSocket connection closed');
    logger.info('WebSocket connection closed');
}); 