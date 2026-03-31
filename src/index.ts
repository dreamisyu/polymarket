import { createApplicationContext } from '@bootstrap/applicationContext';
import { loadAppConfig } from '@config/appConfig';
import { createLoggerFactory, type Logger } from '@shared/logger';

const EXIT_AFTER_SECONDS_FLAGS = ['--exit-after-seconds', '--run-seconds'] as const;

const getExitAfterSeconds = (args: string[]) => {
    let rawValue: string | undefined;
    let matchedFlag: (typeof EXIT_AFTER_SECONDS_FLAGS)[number] | undefined;

    for (let index = 0; index < args.length; index += 1) {
        const currentArg = args[index];

        for (const flag of EXIT_AFTER_SECONDS_FLAGS) {
            if (currentArg === flag) {
                matchedFlag = flag;
                rawValue = args[index + 1];
                index += 1;
                break;
            }

            if (currentArg.startsWith(`${flag}=`)) {
                matchedFlag = flag;
                rawValue = currentArg.slice(flag.length + 1);
                break;
            }
        }
    }

    if (!matchedFlag) {
        return undefined;
    }

    if (rawValue === undefined || !rawValue.trim()) {
        throw new Error(`自动结束参数缺少秒数: ${matchedFlag}，例如 --exit-after-seconds=30`);
    }

    const seconds = Number(rawValue);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(
            `自动结束参数无效: ${rawValue}。请使用正数秒，例如 --exit-after-seconds=30`
        );
    }

    return seconds;
};

const createBootstrapLogger = (): Logger | null => {
    try {
        return createLoggerFactory(loadAppConfig()).createLogger('bootstrap');
    } catch {
        return null;
    }
};

const scheduleAutoExit = (logger: Logger, seconds: number) => {
    logger.info({ seconds }, '已启用自动结束计时');
    setTimeout(
        () => {
            logger.info({ seconds }, '达到自动结束时间，进程退出');
            process.exit(0);
        },
        Math.floor(seconds * 1000)
    );
};

const run = async () => {
    const exitAfterSeconds = getExitAfterSeconds(process.argv.slice(2));
    const applicationContext = await createApplicationContext();
    const appLogger = applicationContext.container.resolve<Logger>('appLogger');

    await applicationContext.app.start();

    if (exitAfterSeconds !== undefined) {
        scheduleAutoExit(appLogger, exitAfterSeconds);
    }
};

void run().catch((error) => {
    const logger = createBootstrapLogger();
    if (logger) {
        logger.error({ err: error }, '启动失败');
    } else {
        console.error('启动失败', error);
    }
    process.exit(1);
});
