import { ENV } from '../config/env';
import liveSettlementWorker from './liveSettlementWorker';
import traceSettlementWorker from './traceSettlementWorker';

interface SettlementWorkerRuntime {
    name: string;
    run: () => Promise<void>;
}

const createSettlementWorker = (): SettlementWorkerRuntime =>
    ENV.EXECUTION_MODE === 'trace'
        ? {
              name: '模拟结算回收器',
              run: traceSettlementWorker,
          }
        : {
              name: '实盘结算回收器',
              run: liveSettlementWorker,
          };

export default createSettlementWorker;
