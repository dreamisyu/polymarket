import connectDB from './config/db';
import { ENV } from './config/env';
import tradeMonitor from './services/tradeMonitor';
import createExecutor from './services/createExecutor';
import createSettlementWorker from './services/createSettlementWorker';
import createLogger from './utils/logger';

const logger = createLogger('app');

const startWorker = (name: string, run: () => Promise<void>) => {
    run().catch((error) => {
        logger.error(`${name} 已退出`, error);
        process.exit(1);
    });
};

export const main = async () => {
    try {
        await connectDB();
        const executor = await createExecutor();
        const settlementWorker = createSettlementWorker();
        logger.info(
            `启动完成 mode=${ENV.EXECUTION_MODE} source=${ENV.USER_ADDRESS} target=${executor.label}`
        );

        startWorker('监视器', () =>
            tradeMonitor({
                onSourceTradesSynced: executor.onSourceTradesSynced,
            })
        );
        startWorker(executor.name, executor.run);
        startWorker(settlementWorker.name, settlementWorker.run);
    } catch (error) {
        logger.error('启动失败', error);
        process.exit(1);
    }
};

void main();
