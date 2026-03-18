type LogMethod = 'info' | 'warn' | 'error';

const normalizeDetails = (details: unknown) => {
    if (details instanceof Error) {
        return details.stack || details.message;
    }

    return details;
};

const writeLog = (method: LogMethod, scope: string, message: string, details?: unknown) => {
    const prefix = `[${scope}] ${message}`;

    if (details === undefined) {
        if (method === 'info') {
            console.log(prefix);
            return;
        }

        console[method](prefix);
        return;
    }

    const normalizedDetails = normalizeDetails(details);
    if (method === 'info') {
        console.log(prefix, normalizedDetails);
        return;
    }

    console[method](prefix, normalizedDetails);
};

const createLogger = (scope: string) => ({
    info: (message: string, details?: unknown) => writeLog('info', scope, message, details),
    warn: (message: string, details?: unknown) => writeLog('warn', scope, message, details),
    error: (message: string, details?: unknown) => writeLog('error', scope, message, details),
});

export default createLogger;
