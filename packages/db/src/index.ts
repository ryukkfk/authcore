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
} from './repositories/index.js';

export {
  passwordCredentials,
  type NewPasswordCredential,
  type PasswordCredential,
  users,
  type NewUser,
  type User,
} from './schema/index.js';
