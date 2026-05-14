import { REFRESH_MAX_WAIT_MS, REFRESH_TRAILING_DEBOUNCE_MS } from "../config";

export interface SchedulerCallbacks {
  isVisible(): boolean;
  flush(): void;
}

export class RefreshScheduler {
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt: number | null = null;
  private pendingWhileHidden = false;
  private disposed = false;

  constructor(private readonly cb: SchedulerCallbacks) {}

  schedule(): void {
    if (this.disposed) return;
    if (!this.cb.isVisible()) {
      this.pendingWhileHidden = true;
      return;
    }

    const now = Date.now();
    if (this.firstPendingAt === null) this.firstPendingAt = now;

    if (this.trailingTimer) clearTimeout(this.trailingTimer);
    this.trailingTimer = setTimeout(() => this.fire(), REFRESH_TRAILING_DEBOUNCE_MS);

    const elapsed = now - this.firstPendingAt;
    if (elapsed >= REFRESH_MAX_WAIT_MS) {
      this.fire();
      return;
    }
    if (!this.maxWaitTimer) {
      const delay = Math.max(0, REFRESH_MAX_WAIT_MS - elapsed);
      this.maxWaitTimer = setTimeout(() => this.fire(), delay);
    }
  }

  notifyVisible(): void {
    if (this.disposed) return;
    if (this.pendingWhileHidden) {
      this.pendingWhileHidden = false;
      this.fire();
    }
  }

  notifyHidden(): void {
    this.clearTimers();
    this.firstPendingAt = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private fire(): void {
    this.clearTimers();
    this.firstPendingAt = null;
    if (this.disposed) return;
    if (!this.cb.isVisible()) {
      this.pendingWhileHidden = true;
      return;
    }
    this.cb.flush();
  }

  private clearTimers(): void {
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }
}
