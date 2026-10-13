export { createDatabaseClient, type DatabaseClient, type DatabaseClientOptions } from './client.js';
export { checkDatabaseConnection } from './health.js';
export {
  DuplicateUserEmailError,
  UserRepository,
  type CreateUserInput,
  type UserRepositoryDatabase,
  PasswordCredentialRepository,
  type CreatePasswordCredentialInput,
  type PasswordCredentialRepositoryDatabase,
  SecurityAuditEventRepository,
  type SecurityAuditEventRepositoryDatabase,
} from './repositories/index.js';

export {
  passwordCredentials,
  type NewPasswordCredential,
  type PasswordCredential,
  users,
  type NewUser,
  type User,
  securityAuditEvents,
  type SecurityAuditEvent,
} from './schema/index.js';

export {
  setSignupTransactionTimeouts,
  runSignupTransaction,
  runOwnedSignupTransaction,
  type SignupOwnerOptions,
  type SignupTransactionEvidence,
  SIGNUP_LOCK_TIMEOUT_MS,
  SIGNUP_STATEMENT_TIMEOUT_MS,
  SIGNUP_TRANSACTION_TIMEOUT_MS,
  SIGNUP_IDLE_TRANSACTION_TIMEOUT_MS,
} from './signup-transaction.js';
export {
  drainSignupTransactionOwners,
  signupOwnerInventory,
  SignupOwnerError,
  AcceptedProofLatch,
  type TransactionOutcome,
  type CleanupHealth,
} from './signup-owner-state.js';
export {
  SignupIdempotencyClaimRepository,
  SignupIdempotencyResultRepository,
  SignupIdempotencyConflictError,
  SignupIdempotencyExpiryError,
  type SignupClaimBinding,
  type SignupClaimKey,
} from './repositories/signup-idempotency.repository.js';
export {
  signupIdempotencyClaims,
  signupIdempotencyResults,
  type SignupIdempotencyClaim,
  type SignupIdempotencyResult,
} from './schema/signup-idempotency.js';
