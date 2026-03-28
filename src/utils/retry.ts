import { retry as retryAsync } from 'radash';

export const computeRetryDelayMs = (
    baseDelayMs: number,
    nextAttempt: number,
    maxDelayMs = 60_000
) => {
    const normalizedBase = Math.max(Math.trunc(baseDelayMs), 1);
    const normalizedAttempt = Math.max(Math.trunc(nextAttempt), 1);
    const normalizedMax = Math.max(Math.trunc(maxDelayMs), normalizedBase);
    const multiplier = 2 ** Math.max(normalizedAttempt - 1, 0);

    return Math.min(normalizedBase * multiplier, normalizedMax);
};

export const runWithRetry = async <T>(
    options: {
        times?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
    },
    task: (attempt: number, exit: (error: unknown) => void) => Promise<T>
) => {
    let attempt = 0;
    return retryAsync(
        {
            times: Math.max(Math.trunc(options.times || 1), 1),
            backoff: (count) =>
                computeRetryDelayMs(options.baseDelayMs || 1, count, options.maxDelayMs || 60_000),
        },
        async (exit) => {
            attempt += 1;
            return task(attempt, exit);
        }
    );
};
