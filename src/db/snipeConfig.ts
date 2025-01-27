/**
 * This file handles the database operations for snipe configurations.
 * A snipe configuration represents settings for automatically purchasing tokens
 * when certain conditions are met. It includes wallet information, amount to spend,
 * and various transaction details.
 *
 * Source: src/db/snipe_config.rs
 */

import { Pool } from 'pg';
import { Keypair } from '@solana/web3.js';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { add as floatAdd, mul as floatMul } from 'exact-math'; // optional or just normal JS
import { DateTime } from 'luxon';

/**
 * Database model representing a snipe configuration.
 * Maps directly to the `snipe_config` table in the database.
 */
export interface SnipeConfigModel {
  wallet: string;         // The wallet address that will execute the snipe
  priv_key: string;       // Private key of the wallet (stored as base58 string)
  snipe_amount: number;   // Amount of SOL to spend on the snipe (in lamports)
  token: string;          // Address of the token to snipe
  jito_tip: number;       // Additional tip for Jito MEV searchers (in lamports)
  main_wallet: string;    // The user's main wallet that created this config
  status: number;         // Status of the snipe (0=pending, other values=completed)
  tx_hash?: string;       // Transaction hash after execution (if completed)
  executed_at?: Date;     // Timestamp of when the snipe was executed
}

/**
 * API response model for snipe configurations.
 * Excludes sensitive information like private keys.
 */
export interface SnipeConfigResponse {
  wallet: string;
  snipe_amount: number;
  token: string;
  main_wallet: string;
  status: number;
  tx_hash?: string;
  executed_at?: Date;
}

/**
 * Conversion function from database model to API response.
 * Rust did `impl From<SnipeConfig> for SnipeConfigResponse`.
 */
export function toSnipeConfigResponse(value: SnipeConfigModel): SnipeConfigResponse {
  return {
    wallet: value.wallet,
    snipe_amount: value.snipe_amount,
    token: value.token,
    main_wallet: value.main_wallet,
    status: value.status,
    tx_hash: value.tx_hash,
    executed_at: value.executed_at,
  };
}

/**
 * API request model for creating a new snipe configuration.
 * Exactly as in the Rust code with `CreateSnipeConfigRequest`.
 */
export interface CreateSnipeConfigRequest {
  main_wallet: string; // User's main wallet address
  amount: number;      // Amount of SOL to spend (in SOL, not lamports)
  token: string;       // Token address to snipe
  jito_tip: number;    // Tip for Jito MEV (in SOL, not lamports)
}

export class SnipeConfig {
  /**
   * Creates a new snipe configuration in the database.
   * Generates a new keypair for the snipe wallet and returns its public key.
   */
  static async insert_snipe_config(
    request: CreateSnipeConfigRequest,
    pool: Pool
  ): Promise<string> {
    // Generate keypair
    const kp = Keypair.generate();

    // Convert SOL to lamports for storage
    const snipeLamports = Math.floor(request.amount * LAMPORTS_PER_SOL);
    const jitoLamports = Math.floor(request.jito_tip * LAMPORTS_PER_SOL);

    const config: SnipeConfigModel = {
      wallet: kp.publicKey.toBase58(),
      priv_key: Buffer.from(kp.secretKey).toString('base64'), // or keep as base58
      snipe_amount: snipeLamports,
      token: request.token,
      jito_tip: jitoLamports,
      main_wallet: request.main_wallet,
      status: 0,
      tx_hash: undefined,
      executed_at: undefined,
    };

    // Insert into DB
    await pool.query(
      `INSERT INTO snipe_config(
        wallet, priv_key, snipe_amount, token, main_wallet, status, tx_hash, executed_at, jito_tip
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        config.wallet,
        config.priv_key,
        config.snipe_amount,
        config.token,
        config.main_wallet,
        config.status,
        config.tx_hash || null,
        config.executed_at || null,
        config.jito_tip,
      ]
    );

    return kp.publicKey.toBase58();
  }

  /**
   * Retrieves all pending snipe configurations (status = 0).
   * Rust name: get_active_snipe_configs
   */
  static async get_active_snipe_configs(pool: Pool): Promise<SnipeConfigModel[]> {
    const { rows } = await pool.query<SnipeConfigModel>(
      `SELECT * FROM snipe_config WHERE status=0`
    );
    return rows;
  }

  /**
   * Retrieves all snipe configurations for a specific main wallet.
   * Returns the API response version (excluding private keys).
   */
  static async get_snipe_configs(
    main_wallet: string,
    pool: Pool
  ): Promise<SnipeConfigResponse[]> {
    const { rows } = await pool.query<SnipeConfigModel>(
      `SELECT * FROM snipe_config WHERE main_wallet=$1`,
      [main_wallet]
    );

    return rows.map(toSnipeConfigResponse);
  }

  /**
   * Updates the status and execution details of a snipe configuration.
   * Used after a snipe has been executed or failed.
   */
  static async update_data(
    wallet: string,
    status: number,
    tx_hash: string | undefined,
    executed_at: Date | undefined,
    pool: Pool
  ): Promise<void> {
    await pool.query(
      `UPDATE snipe_config
       SET status=$1, tx_hash=$2, executed_at=$3
       WHERE wallet=$4`,
      [status, tx_hash || null, executed_at || null, wallet]
    );
  }
}
