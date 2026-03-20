import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import pino, { Logger as PinoLogger, TransportTargetOptions } from 'pino';
import { ENV } from '../config/env';

type LogMethod = 'debug' | 'info' | 'warn' | 'error';

const resolveLogFilePath = () => resolve(process.cwd(), ENV.LOG_FILE_PATH);

const buildTransport = () => {
    const targets: TransportTargetOptions[] = [];

    if (ENV.LOG_CONSOLE_ENABLED) {
        targets.push({
            level: ENV.LOG_CONSOLE_LEVEL,
            target: 'pino-pretty',
            options: {
                colorize: true,
                ignore: 'pid,hostname',
                singleLine: true,
                translateTime: 'yyyy-mm-dd HH:MM:ss.l',
                messageFormat: '[{scope}] {msg}',
            },
        });
    }

    if (ENV.LOG_FILE_ENABLED) {
        const filePath = resolveLogFilePath();
        mkdirSync(dirname(filePath), { recursive: true });
        targets.push({
            level: ENV.LOG_FILE_LEVEL,
            target: 'pino/file',
            options: {
                destination: filePath,
                append: true,
            },
        });
    }

    if (targets.length === 0) {
        return undefined;
    }

    return pino.transport({ targets });
};

const baseLogger = pino(
    {
        level: 'trace',
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
    },
    buildTransport()
);
const scopedLoggers = new Map<string, PinoLogger>();

const getScopedLogger = (scope: string) => {
    const normalizedScope = String(scope || 'app').trim() || 'app';
    const cachedLogger = scopedLoggers.get(normalizedScope);
    if (cachedLogger) {
        return cachedLogger;
    }

    const nextLogger = baseLogger.child({ scope: normalizedScope });
    scopedLoggers.set(normalizedScope, nextLogger);
    return nextLogger;
};

const normalizeDetails = (details: unknown): Record<string, unknown> => {
    if (details instanceof Error) {
        return { err: details };
    }

    if (details && typeof details === 'object') {
        return { detail: details };
    }

    return { detail: details };
};

const writeLog = (method: LogMethod, scope: string, message: string, details?: unknown) => {
    const scopedLogger = getScopedLogger(scope);
    if (details === undefined) {
        scopedLogger[method](message);
        return;
    }

    scopedLogger[method](normalizeDetails(details), message);
};

const createLogger = (scope: string) => ({
    debug: (message: string, details?: unknown) => writeLog('debug', scope, message, details),
    info: (message: string, details?: unknown) => writeLog('info', scope, message, details),
    warn: (message: string, details?: unknown) => writeLog('warn', scope, message, details),
    error: (message: string, details?: unknown) => writeLog('error', scope, message, details),
});

export default createLogger;
