import { ClobClient, OrderType, Side, TickSize } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import ClobMarketStream from '../services/clobMarketStream';
import { ENV } from '../config/env';
import createLogger from './logger';
import {
    buildChunkExecutionPlan,
    cloneMarketSnapshot,
    consumeMarketLiquidity,
} from './executionPlanning';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const logger = createLogger('order');

export type PostOrderStatus = 'SUBMITTED' | 'SKIPPED' | 'RETRYABLE_ERROR' | 'FAILED';

export interface PostOrderResult {
    status: PostOrderStatus;
    reason: string;
    orderIds: string[];
    transactionHashes: string[];
    submissionStatus?: 'SUBMITTED' | 'FAILED';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dedupeStrings = (values: string[]) =>
    [...new Set(values.map((value) => value.trim()))].filter(Boolean);

const mergeReasons = (...reasons: string[]) => dedupeStrings(reasons).join('；');
const getTradeRef = (trade: Pick<UserActivityInterface, 'transactionHash' | 'asset'>) =>
    `tx=${trade.transactionHash} asset=${trade.asset}`;
const extractResponseReason = (response: unknown) =>
    String(
        (response as { errorMsg?: string })?.errorMsg ||
            (response as { error?: string })?.error ||
            (response as { message?: string })?.message ||
            '下单接口返回失败'
    );

const buildResult = (
    status: PostOrderStatus,
    reason = '',
    orderIds: string[] = [],
    transactionHashes: string[] = [],
    submissionStatus?: 'SUBMITTED' | 'FAILED'
): PostOrderResult => ({
    status,
    reason,
    orderIds: dedupeStrings(orderIds),
    transactionHashes: dedupeStrings(transactionHashes),
    submissionStatus,
});

const buildFailureResult = (
    reason: string,
    executedChunks: number,
    orderIds: string[],
    transactionHashes: string[],
    note = ''
): PostOrderResult =>
    buildResult(
        executedChunks > 0 ? 'FAILED' : 'RETRYABLE_ERROR',
        mergeReasons(reason, note),
        orderIds,
        transactionHashes,
        executedChunks > 0 ? 'FAILED' : undefined
    );

const postOrder = async (
    clobClient: ClobClient,
    marketStream: ClobMarketStream,
    condition: string,
    myPosition: Pick<UserPositionInterface, 'asset' | 'size'> | undefined,
    sourcePositionAfterTrade: { size?: number } | undefined,
    trade: UserActivityInterface,
    myBalance: number,
    sourceBalanceAfterTrade: number
): Promise<PostOrderResult> => {
    const orderIds: string[] = [];
    const transactionHashes: string[] = [];
    const baseSnapshot = await marketStream.getSnapshot(trade.asset);
    if (!baseSnapshot) {
        return buildResult('RETRYABLE_ERROR', '市场快照不可用');
    }

    const workingSnapshot = cloneMarketSnapshot(baseSnapshot);
    let retry = 0;
    let executedChunks = 0;
    let remainingRequestedUsdc: number | undefined;
    let remainingRequestedSize: number | undefined;
    let finalNote = '';

    while (retry < RETRY_LIMIT) {
        const plan = buildChunkExecutionPlan({
            condition,
            trade,
            myPositionSize: Math.max(Number(myPosition?.size) || 0, 0),
            sourcePositionAfterTradeSize: Math.max(Number(sourcePositionAfterTrade?.size) || 0, 0),
            availableBalance: myBalance,
            sourceBalanceAfterTrade,
            marketSnapshot: workingSnapshot,
            remainingRequestedUsdc,
            remainingRequestedSize,
        });

        if (plan.note) {
            finalNote = plan.note;
        }

        if (plan.status !== 'READY') {
            if (plan.status === 'SKIPPED') {
                return buildResult('SKIPPED', mergeReasons(plan.reason, finalNote));
            }

            return buildFailureResult(
                plan.reason,
                executedChunks,
                orderIds,
                transactionHashes,
                finalNote
            );
        }

        const orderArgs = {
            side: plan.side as Side,
            tokenID: trade.asset,
            amount: plan.orderAmount,
            price: plan.executionPrice,
        };

        try {
            const response = await clobClient.createAndPostMarketOrder(
                orderArgs,
                {
                    tickSize: plan.tickSize as TickSize,
                    negRisk: plan.negRisk,
                },
                OrderType.FOK
            );

            if (response.success === true) {
                retry = 0;
                executedChunks += 1;

                if (response.orderID) {
                    orderIds.push(response.orderID);
                }
                if (Array.isArray(response.transactionsHashes)) {
                    transactionHashes.push(...response.transactionsHashes);
                }

                if (plan.side === Side.BUY) {
                    remainingRequestedUsdc = Math.max(
                        (remainingRequestedUsdc ?? plan.requestedUsdc) - orderArgs.amount,
                        0
                    );
                    consumeMarketLiquidity(
                        workingSnapshot,
                        Side.BUY,
                        orderArgs.amount,
                        plan.executionPrice
                    );
                    if (remainingRequestedUsdc <= 0) {
                        return buildResult(
                            'SUBMITTED',
                            finalNote,
                            orderIds,
                            transactionHashes,
                            'SUBMITTED'
                        );
                    }
                } else {
                    remainingRequestedSize = Math.max(
                        (remainingRequestedSize ?? plan.requestedSize) - orderArgs.amount,
                        0
                    );
                    consumeMarketLiquidity(
                        workingSnapshot,
                        Side.SELL,
                        orderArgs.amount,
                        plan.executionPrice
                    );
                    if (remainingRequestedSize <= 0) {
                        return buildResult(
                            'SUBMITTED',
                            finalNote,
                            orderIds,
                            transactionHashes,
                            'SUBMITTED'
                        );
                    }
                }

                await sleep(500);
                continue;
            }

            retry += 1;
            logger.warn(
                `${getTradeRef(trade)} 下单失败，准备重试 (${retry}/${RETRY_LIMIT}) ` +
                    `reason=${extractResponseReason(response)}`
            );
            await sleep(2000);
        } catch (error) {
            retry += 1;
            logger.error(
                `${getTradeRef(trade)} 下单异常，准备重试 (${retry}/${RETRY_LIMIT})`,
                error
            );
            await sleep(2000);
        }
    }

    if (condition === 'buy') {
        return buildFailureResult(
            '买单未能全部提交',
            executedChunks,
            orderIds,
            transactionHashes,
            finalNote
        );
    }

    if (condition === 'sell') {
        return buildFailureResult(
            '卖单未能全部提交',
            executedChunks,
            orderIds,
            transactionHashes,
            finalNote
        );
    }

    if (condition === 'merge') {
        return buildFailureResult(
            'merge 未能全部提交',
            executedChunks,
            orderIds,
            transactionHashes,
            finalNote
        );
    }

    return buildResult('SKIPPED', `暂不支持的执行条件: ${condition}`);
};

export default postOrder;
