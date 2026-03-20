import { ENV } from '../config/env';
import createLogger from '../utils/logger';
import LiveSettlementReclaimer from './liveSettlementReclaimer';

const logger = createLogger('settlement-worker');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const liveSettlementWorker = async () => {
    logger.info(`启动实盘结算回收器 interval=${ENV.SETTLEMENT_SWEEP_INTERVAL_MS}ms`);
    const settlementReclaimer = new LiveSettlementReclaimer();

    while (true) {
        await settlementReclaimer.runDue();
        await sleep(ENV.SETTLEMENT_SWEEP_INTERVAL_MS);
    }
};

export default liveSettlementWorker;
