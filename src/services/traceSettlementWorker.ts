import { ENV } from '../config/env';
import createLogger from '../utils/logger';
import { createTraceSettlementScheduler } from './paperTradeExecutor';

const logger = createLogger(`${ENV.TRACE_LABEL}:settlement`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const traceSettlementWorker = async () => {
    logger.info(`启动模拟结算回收器 interval=${ENV.SETTLEMENT_SWEEP_INTERVAL_MS}ms`);
    const scheduler = createTraceSettlementScheduler();

    while (true) {
        await scheduler.runDue();
        await sleep(ENV.SETTLEMENT_SWEEP_INTERVAL_MS);
    }
};

export default traceSettlementWorker;
