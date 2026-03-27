import { connectDatabase } from '../infrastructure/db/connectDatabase';
import { createLogger } from '../utils/logger';
import { createRefactorRuntime } from '../infrastructure/runtime/createRuntime';
import { createRefactorApp } from './createRefactorApp';
import { loadRuntimeConfig } from '../config/runtimeConfig';

const startWorker = (
    logger: ReturnType<typeof createLogger>,
    name: string,
    run: () => Promise<void>
) => {
    run().catch((error) => {
        logger.error(`${name} 已退出`, error);
        process.exit(1);
    });
};

export const main = async () => {
    const config = loadRuntimeConfig();
    await connectDatabase(config);
    const runtime = await createRefactorRuntime(config);
    const app = createRefactorApp(runtime);

    runtime.logger.info(
        `启动完成 mode=${runtime.config.runMode} strategy=${runtime.config.strategyKind} source=${runtime.config.sourceWallet} target=${runtime.config.targetWallet}`
    );

    for (const worker of app.workers) {
        startWorker(runtime.logger, worker.name, worker.run);
    }
};
