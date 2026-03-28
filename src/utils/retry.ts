export const computeRetryDelayMs = (baseDelayMs: number, nextAttempt: number) => {
    const normalizedBase = Math.max(Math.trunc(baseDelayMs), 1);
    const normalizedAttempt = Math.max(Math.trunc(nextAttempt), 1);
    const multiplier = 2 ** Math.max(normalizedAttempt - 1, 0);
    const cappedDelayMs = Math.max(normalizedBase, 60_000);

    return Math.min(normalizedBase * multiplier, cappedDelayMs);
};
