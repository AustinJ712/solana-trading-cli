import WebSocket from 'ws';
import { ENVIRONMENTS } from './config';
import { AppState } from './index';
import { logger } from './logger';
import { MeteoraSniper } from './sniper';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';

// Because we want to parse inner instructions from the meta
// We'll define a small interface to help read them safely:
interface InnerInstruction {
  index: number;
  instructions: Array<{
    accounts: number[];
    data: string;
    programIdIndex: number;
  }>;
}

interface HeliusTransactionMeta {
  logMessages?: string[];
  postTokenBalances?: Array<{
    mint: string;
    owner?: string;
    uiTokenAmount: {
      uiAmount: number | null;
      decimals: number;
      amount: string;
      uiAmountString: string;
    };
  }>;
  innerInstructions?: Array<{
    index: number;
    instructions: Array<{
      programIdIndex: number;
      accounts: number[];
      data: string;
    }>;
  }>;
  // possibly more fields, but we only need these for LB pair
}

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
        // In Helius, "transaction" is an array of base64 strings for versioned TX
        // plus a 'meta' object
        transaction: string[];
        meta: HeliusTransactionMeta;
      };
    };
  };
}

export class HeliusWebSocketClient {
  public state: AppState;
  public wsUrl: string;

  constructor(state: AppState) {
    this.state = state;
    // Using atlas for transactionSubscribe
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

        const signature = msg.params?.result?.signature;
        if (!signature) {
          // No signature => skip
          return;
        }

        const txInfo = msg.params?.result?.transaction;
        if (!txInfo?.transaction || !Array.isArray(txInfo.transaction) || txInfo.transaction.length === 0) {
          logger.debug(`[HeliusWebSocketClient] Transaction data is not in expected format => skipping...`);
          return;
        }

        // 1) Attempt to decode the raw transaction from base64
        let decodedTx: VersionedTransaction;
        try {
          const txData = Buffer.from(txInfo.transaction[0], 'base64');
          decodedTx = VersionedTransaction.deserialize(txData);
          logger.info(`[HeliusWebSocketClient] => Tx signature: ${signature}`);
          logger.debug(`[HeliusWebSocketClient] Decoded TX version = ${decodedTx.version}`);
        } catch (err) {
          logger.error(`[HeliusWebSocketClient] Error deserializing => ${(err as Error).message}`);
          return;
        }

        // 2) Check logs for "initializeLbPair"
        const logMessages = txInfo.meta?.logMessages || [];
        const hasInitPool = logMessages.some((line: string) =>
          line.toLowerCase().includes('instruction: initializelbpair') ||
          line.toLowerCase().includes('instruction: initialize_lb_pair')
        );

        if (!hasInitPool) {
          // Not a pool creation => skip
          return;
        }

        logger.info(`[HeliusWebSocketClient] Found pool creation => signature=${signature}`);

        // 3) Attempt to find LB pair address in the compiled instructions
        //    We look for an instruction whose first 8 data bytes = sighash("initializeLbPair"),
        //    then the first account of that instruction is the LB pair address
        let lbPairAddress: string | null = null;

        const compiledIx = decodedTx.message.compiledInstructions || [];
        const accountKeys = decodedTx.message.staticAccountKeys || [];

        // We'll see if any compiled instruction belongs to the LB program
        // and starts with the correct 8-byte discriminator
        for (const ix of compiledIx) {
          const programId = accountKeys[ix.programIdIndex];
          if (programId.equals(MeteoraSniper.program_id())) {
            const dataBuf = ix.data;
            const disc = dataBuf.subarray(0, 8);
            const expectedDisc = Buffer.from(MeteoraSniper.discriminator());
            if (Buffer.compare(disc, expectedDisc) === 0) {
              // The LB pair is typically the first account index for this instruction
              const lbPairKeyIndex = ix.accountKeyIndexes[0];
              lbPairAddress = accountKeys[lbPairKeyIndex].toBase58();
              break;
            }
          }
        }

        // 4) If we STILL haven't found the LB pair, try the "innerInstructions" from Helius meta
        if (!lbPairAddress) {
          lbPairAddress = this.arrangeLbPairFromInnerCreate(decodedTx, txInfo.meta);
          if (lbPairAddress) {
            logger.debug(`[HeliusWebSocketClient] Recovered LB pair address from 'createAccount' in inner ixs => ${lbPairAddress}`);
          }
        }

        if (!lbPairAddress) {
          logger.error('[HeliusWebSocketClient] Could not find LB pair address in main or inner instructions');
          return;
        }

        // 5) Gather the two token mints from postTokenBalances
        const postTokenBalances = txInfo.meta?.postTokenBalances;
        if (postTokenBalances && postTokenBalances.length >= 2) {
          const [firstBalance, secondBalance] = postTokenBalances;
          const tokenX = firstBalance.mint;
          const tokenY = secondBalance.mint;

          logger.info(`[HeliusWebSocketClient] Pool Details:\nPool Address: ${lbPairAddress}\nTokenX: ${tokenX}\nTokenY: ${tokenY}`);

          // 6) Construct a minimal sniper with that data
          try {
            const sniper = new MeteoraSniper({
              lb_pair: new PublicKey(lbPairAddress),
              bin_array_bitmap_extension: PublicKey.default,
              token_mint_x: new PublicKey(tokenX),
              token_mint_y: new PublicKey(tokenY),
              reserve_x: PublicKey.default,
              reserve_y: PublicKey.default,
              oracle: PublicKey.default,
              preset_parameter: PublicKey.default,
              funder: PublicKey.default,
              token_program: PublicKey.default,
              system_program: PublicKey.default,
              rent: PublicKey.default,
              event_authority: PublicKey.default,
              program: MeteoraSniper.program_id(),
            });

            await sniper.notify(this.state);
            logger.info(`[HeliusWebSocketClient] Notified sniper of new pool => lb_pair=${lbPairAddress}`);
          } catch (err) {
            logger.error(`[HeliusWebSocketClient] Failed to create MeteoraSniper => ${(err as Error).message}`);
          }
        } else {
          logger.warn(`[HeliusWebSocketClient] Found "initializeLbPair" logs but no postTokenBalances => skipping snipe`);
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

  /**
   * If the LB pair is created by a SystemProgram::createAccount inside "innerInstructions",
   * parse that from the meta and return the newly allocated address. This is the same trick
   * you see in the Rust code: often "initializeLbPair" calls createAccount internally.
   *
   * We'll look at 'meta.innerInstructions' for a SystemProgram createAccount with the second
   * account referencing the newly allocated LB pair (the "newAccount").
   */
  private arrangeLbPairFromInnerCreate(decodedTx: VersionedTransaction, meta?: any): string | null {
    if (!meta || !Array.isArray(meta.innerInstructions)) {
      return null;
    }

    // In a legacy transaction, "innerInstructions" may hold multiple sets (one per main instruction index).
    // We'll try to find a "createAccount" call: programIdIndex => SystemProgram is index=0 or 1, etc.
    // We'll do a quick approach:
    const accountKeys = decodedTx.message.staticAccountKeys;
    if (!accountKeys) return null;

    for (const inner of meta.innerInstructions) {
      const instructions = inner.instructions || [];
      for (const iIx of instructions) {
        const progIdIdx = iIx.programIdIndex;
        const programId = accountKeys[progIdIdx];
        if (!programId) continue;

        if (programId.toBase58() === "11111111111111111111111111111111") {
          // SystemProgram => decode the data
          // createAccount => data starts with 4 bytes of instruction idx? Then we can check "owner"?
          // A simpler method: we can see from the accounts array if the second account is the newly allocated
          const accIndexes = iIx.accounts;
          if (accIndexes.length >= 2) {
            // The second account in createAccount is the newAddress
            // Let's parse them:
            const newAccountIndex = accIndexes[1];
            const newAccountAddr = accountKeys[newAccountIndex]?.toBase58();
            if (newAccountAddr) {
              // This is presumably the LB pair. We'll guess that "initializeLbPair" used that new account
              // We can return it, but let's do a quick sanity check if it also has the LB program as the "owner" in the data?
              // If you want to be extra sure, parse the createAccount data. But for now we can just return it.
              return newAccountAddr;
            }
          }
        }
      }
    }

    return null;
  }
}
