/** Shared bounded queue for scheduled workflows and standalone prompt tasks. */
export class ScheduledRunQueue {
  private active = 0
  private readonly queued: Array<() => void> = []
  private readonly byKey = new Map<string, Promise<unknown>>()

  constructor(private readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Scheduled-run queue concurrency must be at least one.')
    }
  }

  enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.byKey.get(key)
    if (existing) return existing as Promise<T>

    let start!: () => void
    const promise = new Promise<T>((resolve, reject) => {
      start = () => {
        this.active += 1
        void run().then(resolve, reject).finally(() => {
          this.active -= 1
          this.byKey.delete(key)
          this.pump()
        })
      }
    })
    this.byKey.set(key, promise)
    this.queued.push(start)
    this.pump()
    return promise
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queued.length > 0) {
      this.queued.shift()!()
    }
  }
}
