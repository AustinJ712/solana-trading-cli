import WebSocket from 'ws';
import { ENVIRONMENTS } from './config';
import { AppState } from './index';
import { filter } from './sniper';
import { MeteoraSniper } from './sniper';
import { logger } from './logger';

export interface HeliusTransactionNotifyMessage {
  jsonrpc: string;
  method: string;
  error?: {
    code: number;
    message: string;
  };
  params: {
    subscription: number;
    result: {
      signature: string;
      transaction: {
        message: any;
        meta: any;
      };
    };
  };
}

export class HeliusWebSocketClient {
  public state: AppState;
  public wsUrl: string;

  constructor(state: AppState) {
    this.state = state;
    this.wsUrl = `wss://atlas-mainnet.helius-rpc.com/?api-key=${ENVIRONMENTS.grpc_token}`;
  }

  public async start_listener(): Promise<void> {
    logger.info(`[HeliusWebSocketClient] Attempting connection => ${this.wsUrl}`);
    await this.connectAndSubscribe();
  }

  private async connectAndSubscribe(): Promise<void> {
    const ws = new WebSocket(this.wsUrl);

    ws.on('open', () => {
      logger.info(`✅ [HeliusWebSocketClient] WebSocket connected. Subscribing to transactions...`);

      // watch for LB program ID
      const subscription = {
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [
          {
            accountInclude: [MeteoraSniper.program_id().toBase58()],
            failed: false,
          },
          {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
            transactionDetails: 'full',
          },
        ],
      };

      try {
        ws.send(JSON.stringify(subscription));
        logger.info(`[HeliusWebSocketClient] Subscription request sent.  Waiting for messages...`);
      } catch (err) {
        logger.error(`[HeliusWebSocketClient] Failed to send sub request => ${(err as Error).message}`);
      }
    });

    ws.on('message', async (rawData: Buffer) => {
      logger.debug(`[HeliusWebSocketClient] Received raw message => ${rawData.toString().slice(0,300)}...`);
      try {
        const dataStr = rawData.toString();
        const msg: HeliusTransactionNotifyMessage = JSON.parse(dataStr);

        if (msg.error) {
          logger.error(`[HeliusWebSocketClient] Subscription error => code=${msg.error.code}, msg=${msg.error.message}`);
          return;
        }
        if (!msg.params?.result?.transaction) {
          logger.debug(`[HeliusWebSocketClient] No transaction data => ${JSON.stringify(msg)}`);
          return;
        }

        const { signature, transaction } = msg.params.result;
        logger.info(`[HeliusWebSocketClient] => Tx signature: ${signature}`);

        // Check if relevant
        const hasValues = filter({
          transaction: {
            transaction: {
              message: transaction.message,
            },
          },
        } as any);

        logger.debug(`[HeliusWebSocketClient] filter => hasValues? ${hasValues}`);
        if (hasValues) {
          logger.info(`[HeliusWebSocketClient] This transaction is relevant => signature=${signature}`);
            try {
            const meteoraSniper = await MeteoraSniper.decompile({
              decompiledInstructions: this.decompileHeliusInstructions(transaction),
              transaction: { transaction: { message: transaction.message } },
            } as any);

              await meteoraSniper.notify(this.state);
            } catch (err) {
            logger.error(`[HeliusWebSocketClient] Failed to decompile => ${(err as Error).message}`);
          }
        }
      } catch (err) {
        logger.error(`[HeliusWebSocketClient] Error processing message => ${(err as Error).message}`);
      }
    });

    ws.on('close', () => {
      logger.warn(`[HeliusWebSocketClient] WebSocket closed. Reconnecting in 5s...`);
      setTimeout(() => this.connectAndSubscribe(), 5000);
    });

    ws.on('error', (err) => {
      logger.error(`[HeliusWebSocketClient] WebSocket error => ${(err as Error).message}`);
      ws.close();
    });
  }

  private decompileHeliusInstructions(heliusTx: any): any[] {
    logger.debug(`[HeliusWebSocketClient] Decompiling Helius instructions from the TX...`);

    const mainIx = heliusTx?.message?.instructions || [];
    const innerIx = heliusTx?.meta?.innerInstructions || [];

    // Flatten them
    const all: any[] = mainIx.map((ix: any, ixIndex: number) => {
      const progIdIdx = ix.programIdIndex;
      const programId = heliusTx.message.accountKeys[progIdIdx] || '';
      return {
        programId,
        data: ix.data ? Buffer.from(ix.data, 'base64') : Buffer.alloc(0),
        accounts: ix.accounts.map((accIdx: number) => ({
          pubkey: heliusTx.message.accountKeys[accIdx],
        })),
      };
    });

    innerIx.forEach((innerObj: any, iIndex: number) => {
      innerObj.instructions.forEach((i: any, subIndex: number) => {
        const progIdIdx = i.programIdIndex;
        const programId = heliusTx.message.accountKeys[progIdIdx] || '';
        all.push({
          programId,
          data: i.data ? Buffer.from(i.data, 'base64') : Buffer.alloc(0),
          accounts: i.accounts.map((accIdx: number) => ({
            pubkey: heliusTx.message.accountKeys[accIdx],
          })),
        });
      });
    });

    logger.debug(`[HeliusWebSocketClient] => total instructions: ${all.length}`);
    return all;
  }
}
