import axios from 'axios';
import createLogger from './logger';

const logger = createLogger('http');

const buildRequestLabel = (url: string) => {
    try {
        const parsedUrl = new URL(url);
        return `${parsedUrl.origin}${parsedUrl.pathname}`;
    } catch {
        return url;
    }
};

const fetchData = async <T>(url: string, retries = 3, delay = 2000): Promise<T | null> => {
    const requestLabel = buildRequestLabel(url);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
            });

            return response.data as T;
        } catch (error: unknown) {
            const isLastAttempt = attempt === retries;
            const errorCode = (error as { code?: string })?.code;
            const errorMessage =
                (error as { message?: string })?.message || errorCode || 'Unknown error';
            const isTimeout = errorCode === 'ETIMEDOUT' || errorCode === 'ECONNABORTED';
            const isNetworkError =
                errorCode === 'ECONNREFUSED' ||
                errorCode === 'ENOTFOUND' ||
                errorCode === 'ECONNRESET' ||
                errorCode === 'EAI_AGAIN';
            const statusCode = (error as { response?: { status?: number } })?.response?.status;
            const isServerError = typeof statusCode === 'number' && statusCode >= 500;
            const isRateLimit = statusCode === 429;

            if (isLastAttempt) {
                logger.error(
                    `请求失败 url=${requestLabel} attempts=${retries} reason=${errorMessage}`
                );
                return null;
            }

            if (isTimeout || isNetworkError || isServerError || isRateLimit) {
                logger.warn(
                    `请求重试 ${attempt}/${retries} url=${requestLabel} delay=${delay}ms reason=${errorMessage}`
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 1.5;
            } else {
                logger.error(`请求失败 url=${requestLabel} reason=${errorMessage}`);
                return null;
            }
        }
    }

    return null;
};

export default fetchData;
