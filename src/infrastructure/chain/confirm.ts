import type { RuntimeConfig } from '../../config/runtimeConfig';
import { createRpcProvider } from './wallet';
import { sleep } from '../../utils/sleep';
import { withRpcTimeout } from './rpc';

export const confirmTransactionHashes = async (
    transactionHashes: string[],
    config: Pick<RuntimeConfig, 'rpcUrl' | 'orderConfirmationTimeoutMs' | 'orderConfirmationPollMs' | 'orderConfirmationBlocks'>,
    options: { timeoutMs?: number } = {}
) => {
    const uniqueHashes = [...new Set(transactionHashes.map((hash) => String(hash || '').trim()))].filter(Boolean);
    if (uniqueHashes.length === 0) {
        return {
            status: 'PENDING' as const,
            reason: '缺少链上交易哈希，等待后续补偿确认',
        };
    }

    const provider = createRpcProvider(config);
    const timeoutMs = options.timeoutMs || config.orderConfirmationTimeoutMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        let confirmedCount = 0;
        for (const hash of uniqueHashes) {
            let receipt;
            try {
                receipt = await withRpcTimeout(
                    provider.getTransactionReceipt(hash),
                    `查询交易回执 hash=${hash}`
                );
            } catch {
                continue;
            }
            if (!receipt) {
                continue;
            }

            if (receipt.status !== 1) {
                return {
                    status: 'FAILED' as const,
                    reason: `链上交易 ${hash} 执行失败`,
                };
            }

            let confirmations = 0;
            try {
                confirmations = await withRpcTimeout(
                    receipt.confirmations(),
                    `查询交易确认数 hash=${hash}`
                );
            } catch {
                continue;
            }
            if (confirmations >= config.orderConfirmationBlocks) {
                confirmedCount += 1;
            }
        }

        if (confirmedCount === uniqueHashes.length) {
            return {
                status: 'CONFIRMED' as const,
                reason: '',
                confirmedAt: Date.now(),
            };
        }

        await sleep(config.orderConfirmationPollMs);
    }

    return {
        status: 'PENDING' as const,
        reason: `等待链上确认超时（${timeoutMs}ms）`,
    };
};
