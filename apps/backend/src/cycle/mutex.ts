/** Runs async functions one after another. Used to keep submissions that consume the Mandate from racing. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `fn` after every earlier call has finished; a failure does not block later calls. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
