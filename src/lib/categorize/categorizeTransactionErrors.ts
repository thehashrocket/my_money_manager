/**
 * Errors raised by `categorizeTransaction` for DB-bound checks that can't be
 * caught by the Zod validator (target row doesn't exist / is a transfer pair).
 */

export class TransactionNotFoundError extends Error {
  constructor(readonly transactionId: number) {
    super(`Transaction ${transactionId} not found`);
    this.name = "TransactionNotFoundError";
  }
}

export class TransferPairedTransactionError extends Error {
  constructor(readonly transactionId: number) {
    super(
      `Transaction ${transactionId} is part of a transfer pair and cannot be categorized manually.`,
    );
    this.name = "TransferPairedTransactionError";
  }
}
