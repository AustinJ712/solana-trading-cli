/**
 * This is the main entry point for the Solana MEV sniper application.
 * It sets up the application state, database connection, "GRPC"/Helius listeners,
 * and HTTP server for handling snipe configurations.
 *
 * Source: src/main.rs (Rust).
 */

import { createServer } from './server';
import { connectToDb } from './db';
import { ENVIRONMENTS } from './config';
import { HeliusWebSocketClient } from './grpc';
import { process_meteora } from './sniper';
import { MeteoraSniper } from './sniper';
import http from 'http';
import { Pool } from 'pg';
import { logger } from './logger'; // <--- new

export interface AppState {
  pool: Pool;
  meteoraChannel: MeteoraSniper[];
}

async function main() {
  logger.info('[Main] Starting sniper...');
  const pool = await connectToDb();
  logger.info(`[Main] DB connected successfully to => ${ENVIRONMENTS.db_url}`);

  const meteoraChannel: MeteoraSniper[] = [];
  const appState: AppState = {
    pool,
    meteoraChannel,
  };

  const heliusListener = new HeliusWebSocketClient(appState);

  const app = createServer(appState);
  const server = http.createServer(app);
  server.listen(ENVIRONMENTS.port, ENVIRONMENTS.host, () => {
    logger.info(`HTTP server listening on http://${ENVIRONMENTS.host}:${ENVIRONMENTS.port}`);
  });

  Promise.all([
    heliusListener.start_listener(),
    (async function runMeteora() {
      // This yields any newly added items from the channel array
      async function* channelGenerator() {
        while (true) {
          if (meteoraChannel.length > 0) {
            yield meteoraChannel.shift() as MeteoraSniper;
          } else {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      return process_meteora(appState, channelGenerator());
    })(),
  ]).catch((err) => {
    logger.error(`[Main] Error => ${err}`);
  });
}

main().catch((err) => logger.error(`[Main] Startup error => ${err}`));

