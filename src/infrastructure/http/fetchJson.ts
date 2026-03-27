import { sleep } from '../../utils/sleep';
import { createLogger } from '../../utils/logger';

const logger = createLogger('http');
const requestTimeoutMs = 10_000;

const shouldRetryStatus = (status: number) => status === 429 || status >= 500;

export const fetchJson = async <T>(url: string, init?: RequestInit, retries = 3, delayMs = 1_500) => {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
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
            clearTimeout(timeout);

            if (!response.ok) {
                if (attempt === retries || !shouldRetryStatus(response.status)) {
                    logger.error(`请求失败 url=${url} status=${response.status}`);
                    return null;
                }

                await sleep(delayMs);
                delayMs = Math.round(delayMs * 1.5);
                continue;
            }

            return (await response.json()) as T;
        } catch (error) {
            clearTimeout(timeout);
            if (attempt === retries) {
                logger.error(`请求失败 url=${url}`, error);
                return null;
            }

            await sleep(delayMs);
            delayMs = Math.round(delayMs * 1.5);
        }
    }

    return null;
};
