/** A data source didn't answer within its time budget. */
export class ProviderTimeoutError extends Error {
  constructor(message = 'The data source took too long to answer.') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

/**
 * A data source can't supply this section right now (down, rate limited, not configured, or has
 * nothing for this input). The message is shown to end users, so keep it plain and free of internals.
 */
export class ProviderUnavailableError extends Error {
  constructor(message = 'Temporarily unavailable.') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export const withTimeout = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
};
