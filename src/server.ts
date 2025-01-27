/**
 * This file sets up an Express server that replicates the Axum-based endpoints from the Rust code:
 *  - POST /snipe/insert
 *  - GET /snipe/mine-snipes/:wallet
 *
 * Also merges the minimal "main.rs" server logic.
 *
 * Source: main.rs + services/sniper_config.rs
 */

import express, { RequestHandler } from 'express';
import { Pool } from 'pg';
import { SnipeConfig, CreateSnipeConfigRequest } from './db/snipeConfig';
import { AppState } from './index';
import * as fs from 'fs';
import * as path from 'path';

// ========= LOGGING UTILITIES =========
const LOG_FILE = path.join(__dirname, 'server.log');

function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logMessage);
}

function log(message: string, toConsole = true) {
  if (toConsole) {
    console.log(message);
  }
  logToFile(message);
}

// Clear log file at startup
if (require.main === module) {
  fs.writeFileSync(LOG_FILE, '');
  log('🚀 Starting HTTP Server...');
}

// Handler: insert_snipe_config
const insertSnipeConfigHandler: RequestHandler = async (req, res) => {
  const state = req.app.get('appState') as AppState;
  const data = req.body as CreateSnipeConfigRequest;

  log('\n📝 Received snipe config insertion request');
  log(`👤 Main Wallet: ${data.main_wallet}`);
  log(`💰 SOL Amount: ${data.amount_sol} SOL`);
  log(`💵 USDC Amount: ${data.amount_usdc} USDC`);
  log(`🪙 Token: ${data.token}`);
  log(`💸 Jito Tip: ${data.jito_tip} SOL`);

  try {
    const walletPubkey = await SnipeConfig.insert_snipe_config(data, state.pool);
    log(`✅ Successfully created snipe config with wallet: ${walletPubkey}`);
    res.json({
      message: 'Successfully inserted snipe config',
      wallet: walletPubkey,
    });
  } catch (e: any) {
    log(`❌ Failed to insert snipe config: ${e}`);
    console.error('Failed to insert snipe config:', e);
    res.status(400).json({
      message: 'Failed to insert config',
      error: e.toString(),
    });
  }
}

// Handler: get_snipe_configs
const getSnipeConfigsHandler: RequestHandler = async (req, res) => {
  const state = req.app.get('appState') as AppState;
  const wallet = req.params.wallet;

  log(`\n🔍 Fetching snipe configs for wallet: ${wallet}`);

  try {
    const data = await SnipeConfig.get_snipe_configs(wallet, state.pool);
    log(`✅ Found ${data.length} snipe configurations`);
    res.json({ data });
  } catch (e: any) {
    log(`❌ Failed to fetch snipe configs: ${e}`);
    console.error('Failed to fetch snipe configs:', e);
    res.status(400).json({ error: e.toString() });
  }
}

export function createServer(appState: AppState) {
  log('\n=========================');
  log('METEORA SNIPER HTTP SERVER');
  log('=========================');

  const app = express();
  app.use(express.json());

  // Attach state
  app.set('appState', appState);

  // Routes
  app.post('/snipe/insert', insertSnipeConfigHandler);
  app.get('/snipe/mine-snipes/:wallet', getSnipeConfigsHandler);

  // Log middleware for all requests
  app.use((req, res, next) => {
    log(`\n📡 ${req.method} ${req.url}`);
    next();
  });

  log('✅ Server routes configured');
  return app;
}
