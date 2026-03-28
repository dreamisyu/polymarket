import { sleep } from '../utils/sleep';
import type { LoggerLike } from '../infrastructure/runtime/contracts';

export interface WorkflowWorker {
    name: string;
    run: () => Promise<void>;
}

export const createLoopWorker = (params: {
    name: string;
    intervalMs: number;
    logger: LoggerLike;
    runOnce: () => Promise<void>;
}): WorkflowWorker => ({
    name: params.name,
    run: async () => {
        while (true) {
            try {
                await params.runOnce();
            } catch (error) {
                params.logger.error({ err: error }, `${params.name} 单轮执行失败，将在下个周期重试`);
            }
            await sleep(params.intervalMs);
        }
    },
});
