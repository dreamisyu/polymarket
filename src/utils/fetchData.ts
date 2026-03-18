import axios from 'axios';

const fetchData = async <T>(url: string, retries = 3, delay = 2000): Promise<T | null> => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Fetching data from: ${url} (attempt ${attempt}/${retries})`);

            const response = await axios.get(url, {
                timeout: 10000, // 10 second timeout
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
                console.error(`Failed to fetch data after ${retries} attempts:`, errorMessage);
                return null;
            }

            if (isTimeout || isNetworkError || isServerError || isRateLimit) {
                console.warn(
                    `Network error (attempt ${attempt}/${retries}): ${errorMessage}. Retrying in ${delay}ms...`
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
                // Exponential backoff
                delay *= 1.5;
            } else {
                // For other errors, don't retry
                console.error('Error fetching data:', errorMessage);
                return null;
            }
        }
    }

    return null;
};

export default fetchData;
