/**
 * This file handles environment configuration for the application using environment variables,
 * replicating the "envconfig" approach from Rust. It provides a centralized way to manage
 * environment variables and configuration settings.
 *
 * Source: environments.rs (Rust)
 */

import { config as dotenvConfig } from 'dotenv';
import { Connection, Keypair, clusterApiUrl } from '@solana/web3.js';
import bs58 from 'bs58';
// Load env variables from .env
dotenvConfig();

/**
 * Environments struct defines all configuration variables that can be loaded from environment.
 * Each field is analogous to the Rust version using envconfig attributes.
 */
export class Environments {
  // GRPC_URL: URL for the GRPC service connection
  public grpc_url: string;

  // GRPC_TOKEN: Optional authentication token for GRPC service
  public grpc_token: string | undefined;

  // RPC_CONNECTION: Solana RPC endpoint URL
  public rpc_connection: string;

  // DB_URL: Database connection string
  public db_url: string;

  // HOST: Server host address
  public host: string;

  // PORT: Server port number
  public port: number;

  // JITO_RPCS: Comma-separated list of Jito RPC endpoints
  public jito_rpcs: string;

  constructor() {
    this.grpc_url = process.env.GRPC_URL || '';
    this.grpc_token = process.env.GRPC_TOKEN || undefined;
    this.rpc_connection = process.env.RPC_CONNECTION || 'https://api.mainnet-beta.solana.com';
    this.db_url = process.env.DATABASE_URL || '';
    this.host = process.env.HOST || '0.0.0.0';
    this.port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    this.jito_rpcs = process.env.JITO_RPCS || '';
  }
}

// In Rust we had "lazy_static!", in TS we can just do a singleton approach:
export const ENVIRONMENTS = new Environments();

export const jito_fee = process.env.JITO_FEE; // 0.00009 SOL
export const shyft_api_key = process.env.SHYFT_API_KEY; // your shyft api key
export const wallet = Keypair.fromSecretKey(
  bs58.decode(process.env.PRIVATE_KEY || "")
);
export const connection = new Connection(ENVIRONMENTS.rpc_connection, "confirmed");

/**
 * In the Rust code, we also had a global RPC_CONNECTION. We replicate that here:
 */
export const RPC_CONNECTION = new Connection(ENVIRONMENTS.rpc_connection, 'confirmed');
