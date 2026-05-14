import { DEFAULT_IDLE_TIMEOUT_MS, ModelError } from "./model.js";

export type IdleWatchdogOptions = {
  idleMs?: number;
  requestId?: string;
  onTimeout?: () => void;
};

export async function* withIdleWatchdog<T>(
  source: AsyncIterable<T>,
  options: IdleWatchdogOptions = {}
): AsyncIterable<T> {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const iterator = source[Symbol.asyncIterator]();

  try {
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          options.onTimeout?.();
          reject(
            new ModelError("timeout", `model stream was idle for ${idleMs}ms`, {
              requestId: options.requestId
            })
          );
        }, idleMs);
      });

      let result: IteratorResult<T>;
      try {
        result = await Promise.race([iterator.next(), timeoutPromise]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }

      if (result.done) {
        return;
      }

      yield result.value;
    }
  } finally {
    void iterator.return?.();
  }
}
