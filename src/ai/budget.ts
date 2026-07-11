/**
 * Cost/rate controls for the inference layer. When the budget is exhausted,
 * minds silently degrade to their deterministic fallback policy — the game
 * never stalls and never surprise-bills.
 */
export interface BudgetConfig {
  /** Max LLM requests per rolling minute across all minds. Default 30. */
  requestsPerMinute?: number;
  /** Max concurrent in-flight requests. Default 4. */
  maxConcurrent?: number;
  /** Max total requests for the session (0 = unlimited). Default 0. */
  maxTotal?: number;
}

export class InferenceBudget {
  private rpm: number;
  private maxConcurrent: number;
  private maxTotal: number;
  private stamps: number[] = [];
  private inFlight = 0;
  total = 0;
  denied = 0;

  constructor(cfg: BudgetConfig = {}) {
    this.rpm = cfg.requestsPerMinute ?? 30;
    this.maxConcurrent = cfg.maxConcurrent ?? 4;
    this.maxTotal = cfg.maxTotal ?? 0;
  }

  /** Try to reserve a request slot. Caller MUST release() when done. */
  tryAcquire(now = Date.now()): boolean {
    const cutoff = now - 60_000;
    while (this.stamps.length && this.stamps[0] < cutoff) this.stamps.shift();
    if (this.inFlight >= this.maxConcurrent) return this.deny();
    if (this.stamps.length >= this.rpm) return this.deny();
    if (this.maxTotal > 0 && this.total >= this.maxTotal) return this.deny();
    this.stamps.push(now);
    this.inFlight++;
    this.total++;
    return true;
  }

  private deny(): false {
    this.denied++;
    return false;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  stats() {
    return { total: this.total, denied: this.denied, inFlight: this.inFlight };
  }
}

/** Tiny content-addressed cache for Genesis-style generation calls. */
export class ResponseCache {
  private map = new Map<string, string>();
  constructor(private limit = 200) {}

  key(parts: unknown[]): string {
    const s = JSON.stringify(parts);
    // djb2 — good enough for a cache key; collisions just cost a regen
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return `${s.length}:${h}`;
  }

  get(k: string): string | undefined {
    return this.map.get(k);
  }

  set(k: string, v: string): void {
    if (this.map.size >= this.limit) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(k, v);
  }
}
