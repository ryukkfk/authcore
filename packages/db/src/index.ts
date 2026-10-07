export { createDatabaseClient, type DatabaseClient, type DatabaseClientOptions } from './client.js';

export { checkDatabaseConnection } from './health.js';

export {
  DuplicateUserEmailError,
  UserRepository,
  type CreateUserInput,
  type UserRepositoryDatabase,
} from './repositories/index.js';

export { users, type NewUser, type User } from './schema/index.js';
