/** Local native work ownership only; never a fleet-wide memory guarantee. */
export class PasswordWork {
  private readonly owners = new Set<Promise<unknown>>();
  private closing = false;
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing || this.owners.size >= 4) throw new Error('PASSWORD_WORK_UNAVAILABLE');
    const actual = Promise.resolve().then(work);
    this.owners.add(actual);
    try {
      return await actual;
    } finally {
      this.owners.delete(actual);
    }
  }
  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.owners]);
  }
  inventory() {
    return { active: this.owners.size, closing: this.closing };
  }
}
