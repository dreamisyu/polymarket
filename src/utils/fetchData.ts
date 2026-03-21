import createLogger from './logger';
import { sleep } from './runtime';

const logger = createLogger('http');
const REQUEST_TIMEOUT_MS = 10_000;

const buildRequestLabel = (url: string) => {
    try {
        const parsedUrl = new URL(url);
        return `${parsedUrl.origin}${parsedUrl.pathname}`;
    } catch {
        return url;
    }
};

const shouldRetryStatus = (status: number) => status === 429 || status >= 500;

const fetchData = async <T>(url: string, retries = 3, delay = 2000): Promise<T | null> => {
    const requestLabel = buildRequestLabel(url);

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                method: 'GET',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
            });
            clearTimeout(timeout);

            if (!response.ok) {
                const reason = `HTTP ${response.status}`;
                if (attempt === retries || !shouldRetryStatus(response.status)) {
                    logger.error(`请求失败 url=${requestLabel} reason=${reason}`);
                    return null;
                }

                logger.warn(
                    `请求重试 ${attempt}/${retries} url=${requestLabel} delay=${delay}ms reason=${reason}`
                );
                await sleep(delay);
                delay = Math.round(delay * 1.5);
                continue;
            }

            return (await response.json()) as T;
        } catch (error: unknown) {
            clearTimeout(timeout);
            const isLastAttempt = attempt === retries;
            const errorName = (error as { name?: string })?.name;
            const errorMessage =
                (error as { message?: string })?.message || errorName || 'Unknown error';
            const isRetryable =
                errorName === 'AbortError' ||
                /timed out|timeout|network|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(
                    errorMessage
                );

            if (isLastAttempt || !isRetryable) {
                logger.error(
                    `请求失败 url=${requestLabel} attempts=${retries} reason=${errorMessage}`
                );
                return null;
            }

            logger.warn(
                `请求重试 ${attempt}/${retries} url=${requestLabel} delay=${delay}ms reason=${errorMessage}`
            );
            await sleep(delay);
            delay = Math.round(delay * 1.5);
        }
    }

    return null;
};

export default fetchData;
