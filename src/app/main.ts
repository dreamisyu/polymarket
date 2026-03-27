import { connectDatabase } from '../infrastructure/db/connectDatabase';
import { createLogger } from '../utils/logger';
import { createRuntime } from '../infrastructure/runtime/createRuntime';
import { createApp } from './createApp';
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
    const runtime = await createRuntime(config);
    const app = createApp(runtime);

    runtime.logger.info(
        `启动完成 mode=${runtime.config.runMode} strategy=${runtime.config.strategyKind} self=${runtime.config.sourceWallet} follow=${runtime.config.targetWallet}`
    );

    for (const worker of app.workers) {
        startWorker(runtime.logger, worker.name, worker.run);
    }
};
