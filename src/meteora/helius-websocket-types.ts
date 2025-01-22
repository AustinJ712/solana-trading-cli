export interface TransactionNotification {
  params?: {
    result?: {
      signature: string;
      transaction: {
        meta: {
          err: any;
          logMessages?: string[];
        };
        transaction: {
          message: {
            accountKeys: { pubkey: string }[];
            instructions: {
              programId: string;
              accounts: string[];
              data: string;
            }[];
          };
        };
      };
    };
  };
}

export interface HeliusInstruction {
  programId: string;
  accounts: string[];
  data: string;
}

export interface HeliusAccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}
