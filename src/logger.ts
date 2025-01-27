// src/logger.ts

import fs from 'fs';
import path from 'path';
import winston, { format, transports, Logform } from 'winston';

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

/**
 * Track console output lines to limit after 100
 */
let consoleLineCount = 0;

/**
 * Filter that limits console output after 100 lines
 * unless the message contains special markers
 */
const consoleLogLimiter = format((info: Logform.TransformableInfo) => {
  // Special messages always show in console
  const message = info.message as string;
  const isSpecial = 
    message.includes('FOUND A NEW POOL') ||
    message.includes('SWAP SUCCESS');

  if (isSpecial) {
    return info;
  }

  // Normal messages only show for first 100 lines
  if (consoleLineCount < 100) {
    consoleLineCount++;
    return info;
  }

  return false;
});

const customFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `[${timestamp}] [${level}] ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  return msg;
});

export const logger = winston.createLogger({
  level: 'debug',
  format: combine(timestamp(), customFormat),
  transports: [
    // Log to console with color and line limiting
    new transports.Console({
      format: combine(
        consoleLogLimiter(),
        colorize(),
        timestamp(),
        customFormat
      ),
    }),

    // Log everything to file without limits
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
