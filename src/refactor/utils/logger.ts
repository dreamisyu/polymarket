import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pino, { type TransportTargetOptions } from 'pino';

export type Logger = ReturnType<typeof createLogger>;

const logLevel = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
const logFilePath = (process.env.LOG_FILE_PATH || '').trim();

const buildTransport = () => {
    if (process.env.NODE_ENV === 'test') {
        return undefined;
    }

    const targets: TransportTargetOptions[] = [
        {
            level: logLevel,
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
            },
        },
    ];

    if (logFilePath) {
        const destination = resolve(process.cwd(), logFilePath);
        mkdirSync(dirname(destination), { recursive: true });
        targets.push({
            level: logLevel,
            target: 'pino/file',
            options: {
                destination,
                append: true,
            },
        });
    }

    return pino.transport({ targets });
};

const rootLogger = pino({
    level: logLevel,
}, buildTransport());

export const createLogger = (name: string) => rootLogger.child({ scope: name });
