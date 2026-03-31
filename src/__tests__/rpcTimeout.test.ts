import { describe, expect, it, jest } from '@jest/globals';
import { withRpcTimeout } from '@infrastructure/chain/rpc';

describe('withRpcTimeout', () => {
    it('超时后会拒绝，避免 RPC Promise 长时间挂起', async () => {
        jest.useFakeTimers();

        const pending = withRpcTimeout(new Promise<never>(() => undefined), '读取余额', 25);
        const assertion = expect(pending).rejects.toThrow('读取余额 超时（25ms）');
        await jest.advanceTimersByTimeAsync(25);

        await assertion;
        jest.useRealTimers();
    });

    it('任务在超时前完成时会直接返回结果', async () => {
        await expect(withRpcTimeout(Promise.resolve(42), '读取余额', 25)).resolves.toBe(42);
    });
});
