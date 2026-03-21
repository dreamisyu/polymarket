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
    transactionHashes: string[]
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

    while (Date.now() - startedAt < ORDER_CONFIRMATION_TIMEOUT_MS) {
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
            if (confirmations >= ORDER_CONFIRMATION_BLOCKS) {
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

        await sleep(ORDER_CONFIRMATION_POLL_MS);
    }

    return {
        status: 'PENDING',
        reason: `等待链上确认超时（${ORDER_CONFIRMATION_TIMEOUT_MS}ms）`,
    };
};

export default confirmTransactionHashes;
