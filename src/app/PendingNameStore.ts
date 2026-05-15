interface Claim {
  readonly name: string;
  readonly expiresAt: number;
}

export class PendingNameStore {
  private claim: Claim | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  set(name: string, ttlMs: number): void {
    this.claim = { name, expiresAt: this.now() + ttlMs };
  }

  take(): string | null {
    const claim = this.claim;
    if (!claim) return null;
    this.claim = null;
    if (claim.expiresAt < this.now()) return null;
    return claim.name;
  }

  clear(): void {
    this.claim = null;
  }

  isPending(): boolean {
    if (!this.claim) return false;
    if (this.claim.expiresAt < this.now()) {
      this.claim = null;
      return false;
    }
    return true;
  }
}
