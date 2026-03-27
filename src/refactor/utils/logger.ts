import pino from 'pino';

export type Logger = ReturnType<typeof createLogger>;

const logLevel = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();

const rootLogger = pino({
    level: logLevel,
    transport:
        process.env.NODE_ENV === 'test'
            ? undefined
            : {
                  target: 'pino-pretty',
                  options: {
                      colorize: true,
                      translateTime: 'SYS:standard',
                      ignore: 'pid,hostname',
                  },
              },
});

export const createLogger = (name: string) => rootLogger.child({ scope: name });
