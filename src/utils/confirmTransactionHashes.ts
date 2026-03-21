import { ENV } from '../config/env';
import { getRpcProvider } from './getMyBalance';
import { sleep } from './runtime';

const ORDER_CONFIRMATION_TIMEOUT_MS = ENV.ORDER_CONFIRMATION_TIMEOUT_MS;
const ORDER_CONFIRMATION_POLL_MS = ENV.ORDER_CONFIRMATION_POLL_MS;
const ORDER_CONFIRMATION_BLOCKS = ENV.ORDER_CONFIRMATION_BLOCKS;

type ConfirmationStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

export interface TransactionConfirmationResult {
    status: ConfirmationStatus;
    reason: string;
    confirmedAt?: number;
}

const confirmTransactionHashes = async (
    transactionHashes: string[],
    options: {
        timeoutMs?: number;
        pollMs?: number;
        confirmationBlocks?: number;
    } = {}
): Promise<TransactionConfirmationResult> => {
    const uniqueHashes = [
        ...new Set(transactionHashes.map((hash) => String(hash || '').trim())),
    ].filter(Boolean);

    if (uniqueHashes.length === 0) {
        return {
            status: 'PENDING',
            reason: '缺少链上交易哈希，等待后续补偿确认',
        };
    }

    const provider = getRpcProvider();
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs || ORDER_CONFIRMATION_TIMEOUT_MS;
    const pollMs = options.pollMs || ORDER_CONFIRMATION_POLL_MS;
    const confirmationBlocks = options.confirmationBlocks || ORDER_CONFIRMATION_BLOCKS;

    while (Date.now() - startedAt < timeoutMs) {
        let confirmedCount = 0;

        for (const hash of uniqueHashes) {
            const receipt = await provider.getTransactionReceipt(hash);
            if (!receipt) {
                continue;
            }

            if (receipt.status !== 1) {
                return {
                    status: 'FAILED',
                    reason: `链上交易 ${hash} 执行失败`,
                };
            }

            const confirmations = await receipt.confirmations();
            if (confirmations >= confirmationBlocks) {
                confirmedCount += 1;
            }
        }

        if (confirmedCount === uniqueHashes.length) {
            return {
                status: 'CONFIRMED',
                reason: '',
                confirmedAt: Date.now(),
            };
        }

        await sleep(pollMs);
    }

    return {
        status: 'PENDING',
        reason: `等待链上确认超时（${timeoutMs}ms）`,
    };
};

export default confirmTransactionHashes;
