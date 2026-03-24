import connectDB from '../../config/db';
import createLogger from '../../utils/logger';
import { createRefactorRuntime } from '../infrastructure/runtime/createRuntime';
import { createRefactorApp } from './createRefactorApp';

type LoggerLike = ReturnType<typeof createLogger>;

const startWorker = (
    logger: LoggerLike,
    name: string,
    run: () => Promise<void>
) => {
    run().catch((error) => {
        logger.error(`${name} 已退出`, error);
        process.exit(1);
    });
};

export const main = async () => {
    await connectDB();
    const runtime = await createRefactorRuntime();
    const app = createRefactorApp(runtime);

    runtime.logger.info(
        `启动完成 mode=${runtime.config.runMode} strategy=${runtime.config.strategyKind} source=${runtime.config.sourceWallet} target=${runtime.config.targetWallet}`
    );

    for (const worker of app.workers) {
        startWorker(runtime.logger, worker.name, worker.run);
    }
};
