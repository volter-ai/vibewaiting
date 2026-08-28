export interface GrokBuildAutoWakeDependencies {
  waitForIdle(): Promise<void>;
  claimReminder(promptId: string): string | undefined;
  runWake(promptId: string, reminder: string): Promise<void>;
  onError?(error: unknown): void;
}

/** Serializes native synthetic turns without combining independent completions. */
export class GrokBuildAutoWakeCoordinator {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private draining = false;
  private generation = 0;

  constructor(private readonly dependencies: GrokBuildAutoWakeDependencies) {}

  enqueue(promptId: string): void {
    if (!promptId || this.queued.has(promptId)) return;
    this.queued.add(promptId);
    this.queue.push(promptId);
    void this.drain();
  }

  clear(): void {
    this.generation += 1;
    this.queue.splice(0);
    this.queued.clear();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const generation = this.generation;
    try {
      while (this.queue.length > 0 && generation === this.generation) {
        const promptId = this.queue.shift()!;
        this.queued.delete(promptId);
        await this.dependencies.waitForIdle();
        if (generation !== this.generation) return;
        const reminder = this.dependencies.claimReminder(promptId);
        if (!reminder) continue;
        await this.dependencies.runWake(promptId, reminder);
      }
    } catch (error) {
      this.dependencies.onError?.(error);
    } finally {
      this.draining = false;
      if (this.queue.length > 0) void this.drain();
    }
  }
}
