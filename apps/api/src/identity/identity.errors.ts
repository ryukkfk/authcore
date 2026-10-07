export class EmailAlreadyInUseError extends Error {
  constructor() {
    super('Email address is already in use');
    this.name = 'EmailAlreadyInUseError';
  }
}