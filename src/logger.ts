// src/logger.ts

import fs from 'fs';
import path from 'path';
import winston, { format, transports } from 'winston';

// We'll store logs in the project root:
const LOG_FILE = path.join(process.cwd(), 'meteora-sniper.log');

console.log(`Creating log file at: ${LOG_FILE}`);

// Create logs directory if it doesn't exist
const logsDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Winston configuration
const { combine, timestamp, printf, colorize } = format;

const customFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `[${timestamp}] [${level}] ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  return msg;
});

export const logger = winston.createLogger({
  level: 'debug',
  format: combine(
    timestamp(),
    customFormat
  ),
  transports: [
    // Log to console with color
    new transports.Console({
      format: combine(colorize(), timestamp(), customFormat),
    }),

    // Also log to file
    new transports.File({
      filename: LOG_FILE,
      level: 'debug',
    }),
  ],
});

// Helper to quickly log to file if you want a direct function:
export function logToFile(msg: string) {
  logger.debug(msg);
}

// Log when the logger is initialized
logger.info('Logger initialized');
