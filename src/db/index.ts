/**
 * This module handles database connections and contains submodules for different
 * database operations. It provides a central point for database functionality
 * across the application.
 *
 * Source: src/db/mod.rs
 */

import { Pool } from 'pg';
import { ENVIRONMENTS } from '../config';

// Re-export submodules
export * from './snipeConfig';
export * from './snipedPools';

/**
 * Establishes a connection to the PostgreSQL database.
 * Uses the database URL from environment variables.
 */
export async function connectToDb(): Promise<Pool> {
  const pool = new Pool({ connectionString: ENVIRONMENTS.db_url });
  // Attempt a simple query to confirm connection
  await pool.query('SELECT 1');
  return pool;
}
