import { PublicKey } from '@solana/web3.js';

// Program IDs
export const PROGRAM_ID = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";
export const DYNAMIC_AMM_PROGRAM_ID = new PublicKey(PROGRAM_ID);

// Common token mints
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

// For backwards compatibility
export const wsol = WSOL_MINT.toBase58();
export const usdc = USDC_MINT.toBase58();
export const usdt = USDT_MINT.toBase58();

// Default settings
export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
export const DEFAULT_COMPUTE_UNITS = 200_000;
export const DEFAULT_PRIORITY_FEE = 1_000_000; // microLamports
export const DEFAULT_CONFIRMATION_TIMEOUT = 30000; // 30 seconds

