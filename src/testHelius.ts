// testHeliusConnection.ts
import WebSocket from 'ws';

// Insert your actual Helius API key here:
const HELIUS_API_KEY = 'e7a0fa4f-35a0-44b0-abcc-67b82875b2df';
const wsUrl = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function runTest() {
  console.log('Connecting to:', wsUrl);
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('Connected to Helius! Sending transactionSubscribe...');
    // Here, we subscribe to *all* transactions so you see data flow
    // If you only want to see a specific program, pass accountInclude
    const subReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        {
          // removing 'accountInclude' means everything
          failed: false
        },
        {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
          transactionDetails: 'full'
        }
      ]
    };
    ws.send(JSON.stringify(subReq));
  });

  ws.on('message', (data) => {
    console.log('[Message from Helius]:', data.toString());
  });

  ws.on('error', (err) => {
    console.error('[WebSocket error]', err);
  });

  ws.on('close', () => {
    console.log('[WebSocket closed] Reconnecting in 5s...');
    setTimeout(runTest, 5000);
  });
}

runTest();
