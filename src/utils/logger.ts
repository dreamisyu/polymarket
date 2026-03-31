import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pino, { type Logger as PinoLogger, type TransportTargetOptions } from 'pino';
import type { AppConfig } from '@config/appConfig';
import { loadAppConfig } from '@config/appConfig';

export type Logger = PinoLogger;

export interface LoggerFactory {
    root: Logger;
    createLogger: (scope: string) => Logger;
}

let defaultLoggerFactory: LoggerFactory | null = null;

const buildTransport = (config: Pick<AppConfig, 'nodeEnv' | 'logLevel' | 'logFilePath'>) => {
    if (config.nodeEnv === 'test') {
        return undefined;
    }

    const targets: TransportTargetOptions[] = [
        {
            level: config.logLevel,
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
            },
        },
    ];

    if (config.logFilePath) {
        const destination = resolve(process.cwd(), config.logFilePath);
        mkdirSync(dirname(destination), { recursive: true });
        targets.push({
            level: config.logLevel,
            target: 'pino/file',
            options: {
                destination,
                append: true,
            },
        });
    }

    return pino.transport({ targets });
};

export const createLoggerFactory = (
    config: Pick<AppConfig, 'nodeEnv' | 'logLevel' | 'logFilePath'>
): LoggerFactory => {
    const root = pino(
        {
            level: config.logLevel,
        },
        buildTransport(config)
    );

    return {
        root,
        createLogger: (scope: string) => root.child({ scope }),
    };
};

const getDefaultLoggerFactory = () => {
    if (!defaultLoggerFactory) {
        defaultLoggerFactory = createLoggerFactory(loadAppConfig());
    }

    return defaultLoggerFactory;
};

export const createLogger = (scope: string) => getDefaultLoggerFactory().createLogger(scope);
