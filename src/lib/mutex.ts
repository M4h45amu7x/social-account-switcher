// Runs async jobs one at a time, in the order they were queued. Used for read-modify-write on
// storage.local, so a Facebook switch and an Instagram switch can't overwrite each other's store.
export interface Mutex {
  run<T>(job: () => Promise<T>): Promise<T>;
}

export function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(job) {
      const result = tail.then(job);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
