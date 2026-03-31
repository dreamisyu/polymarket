import { createLogger } from '@shared/logger';
import { runWithRetry } from '@shared/retry';

const logger = createLogger('http');
const requestTimeoutMs = 10_000;

const shouldRetryStatus = (status: number) => status === 429 || status >= 500;

export const fetchJson = async <T>(
    url: string,
    init?: RequestInit,
    retries = 3,
    delayMs = 1_500
) => {
    try {
        return await runWithRetry<T | null>(
            {
                times: retries,
                baseDelayMs: delayMs,
            },
            async () => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

                try {
                    const response = await fetch(url, {
                        ...init,
                        signal: controller.signal,
                        headers: {
                            'User-Agent': 'polymarket-copytrading-bot/next',
                            ...(init?.headers || {}),
                        },
                    });

                    if (!response.ok) {
                        if (!shouldRetryStatus(response.status)) {
                            logger.error(`请求失败 url=${url} status=${response.status}`);
                            return null;
                        }

                        throw new Error(`请求失败 status=${response.status}`);
                    }

                    return (await response.json()) as T;
                } finally {
                    clearTimeout(timeout);
                }
            }
        );
    } catch (error) {
        logger.error({ error }, `请求失败 url=${url}`);
        return null;
    }
};
