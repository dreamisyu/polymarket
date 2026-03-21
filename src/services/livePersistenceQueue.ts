import createLogger from '../utils/logger';
import { sleep } from '../utils/runtime';

interface PersistenceTask {
    label: string;
    execute: () => Promise<void>;
}

interface LivePersistenceQueueOptions {
    maxQueueSize: number;
    retryDelayMs: number;
}

const logger = createLogger('live-persist');

class LivePersistenceQueue {
    private readonly maxQueueSize: number;
    private readonly retryDelayMs: number;
    private readonly queue: PersistenceTask[] = [];
    private draining = false;

    constructor(options: LivePersistenceQueueOptions) {
        this.maxQueueSize = options.maxQueueSize;
        this.retryDelayMs = options.retryDelayMs;
    }

    enqueue(label: string, execute: () => Promise<void>) {
        if (this.queue.length >= this.maxQueueSize) {
            logger.error(`持久化队列已满 size=${this.queue.length} label=${label}`);
            throw new Error(`持久化队列已满，无法继续写入 ${label}`);
        }

        this.queue.push({ label, execute });
        void this.drain();
    }

    size() {
        return this.queue.length;
    }

    async waitUntilIdle(timeoutMs = 5000) {
        const startedAt = Date.now();
        while (this.draining || this.queue.length > 0) {
            if (Date.now() - startedAt > timeoutMs) {
                return false;
            }

            await sleep(20);
        }

        return true;
    }

    private async drain() {
        if (this.draining) {
            return;
        }

        this.draining = true;
        try {
            while (this.queue.length > 0) {
                const task = this.queue[0];
                if (!task) {
                    break;
                }

                try {
                    await task.execute();
                    this.queue.shift();
                } catch (error) {
                    logger.error(`持久化失败 label=${task.label}`, error);
                    await sleep(this.retryDelayMs);
                }
            }
        } finally {
            this.draining = false;
            if (this.queue.length > 0) {
                void this.drain();
            }
        }
    }
}

export default LivePersistenceQueue;
