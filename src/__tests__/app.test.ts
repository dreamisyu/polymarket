import { describe, expect, it, jest } from '@jest/globals';
import { createLoopWorker } from '../app/loopWorker';

jest.mock('../utils/sleep', () => ({
    __esModule: true,
    sleep: jest.fn(),
}));

const { sleep } = jest.requireMock('../utils/sleep') as {
    sleep: jest.MockedFunction<(ms: number) => Promise<void>>;
};

describe('createLoopWorker', () => {
    it('单轮执行失败后会记录日志并继续下一轮', async () => {
        const logger = {
            error: jest.fn(),
        };
        const runOnce = jest
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce(undefined);
        sleep
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('stop'));

        const worker = createLoopWorker({
            name: '监控分发工作流',
            intervalMs: 10,
            logger: logger as never,
            runOnce,
        });

        await expect(worker.run()).rejects.toThrow('stop');
        expect(runOnce).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledWith(
            { err: expect.any(Error) },
            '监控分发工作流 单轮执行失败，将在下个周期重试'
        );
    });
});
