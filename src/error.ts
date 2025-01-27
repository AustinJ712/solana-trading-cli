/**
 * This file defines custom error types for the sniper application,
 * mirroring the Rust-based `SniperError` enum from error.rs.
 * It uses a standard TypeScript class to replicate the same variants.
 */

export enum SniperErrorVariant {
    InstructionNotFound = 'InstructionNotFound',
    InstructionNotParsed = 'InstructionNotParsed',
    TransactionFailed = 'TransactionFailed',
  }
  
  export class SniperError extends Error {
    public variant: SniperErrorVariant;
    public details?: string;
  
    constructor(variant: SniperErrorVariant, details?: string) {
      super();
      this.variant = variant;
      this.details = details;
      this.name = 'SniperError';
  
      // In Rust, the error messages were:
      // #[error("Instruction not found!")]
      // #[error("Could not parse instruction")]
      // #[error("Transaction failed {0}")]
      switch (variant) {
        case SniperErrorVariant.InstructionNotFound:
          this.message = 'Instruction not found!';
          break;
        case SniperErrorVariant.InstructionNotParsed:
          this.message = 'Could not parse instruction';
          break;
        case SniperErrorVariant.TransactionFailed:
          this.message = `Transaction failed ${details || ''}`;
          break;
        default:
          this.message = 'Unknown sniper error';
      }
    }
  }
  