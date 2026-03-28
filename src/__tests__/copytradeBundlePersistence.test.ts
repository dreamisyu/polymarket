import { describe, expect, it, jest } from '@jest/globals';
import type { SourceTradeEvent } from '../domain';
import type { NodeContext } from '../domain/nodes/kernel/NodeContext';
import { PersistExecutionNode } from '../domain/nodes/copytrade/PersistExecutionNode';

const buildEvent = (activityKey: string, attemptCount = 0): SourceTradeEvent => ({
    _id: `507f1f77bcf86cd7994390${activityKey.slice(-2)}` as never,
    sourceWallet: '0xtarget',
    activityKey,
    timestamp: Date.now(),
    type: 'TRADE',
    side: 'BUY',
    action: 'buy',
    transactionHash: `hash-${activityKey}`,
    conditionId: 'condition-1',
    asset: 'asset-1',
    outcome: 'Yes',
    outcomeIndex: 0,
    title: 'market-1',
    slug: 'market-1',
    eventSlug: 'event-1',
    price: 0.54,
    size: 1,
    usdcSize: 1,
    executionIntent: 'EXECUTE',
    attemptCount,
    raw: {},
});

const buildContext = (overrides: Partial<NodeContext> = {}) =>
    ({
        workflowId: 'copytrade:fixed_amount:bundle-1',
        workflowKind: 'copytrade',
        runMode: 'paper',
        strategyKind: 'fixed_amount',
        runtime: {
            config: {
                runMode: 'paper',
                strategyKind: 'fixed_amount',
                sourceWallet: 'source',
                targetWallet: 'target',
                mongoUri: 'mongodb://localhost/test',
                scopeKey: 'scope',
                monitorIntervalMs: 1000,
                monitorInitialLookbackMs: 1000,
                monitorOverlapMs: 1000,
                activitySyncLimit: 100,
                activityAdjacentMergeWindowMs: 1000,
                snapshotStaleAfterMs: 1000,
                retryBackoffMs: 1000,
                maxRetryCount: 2,
                copytradeDispatchConcurrency: 2,
                settlementIntervalMs: 1000,
                settlementMaxTasksPerRun: 8,
                fixedTradeAmountUsdc: 1.2,
                maxOpenPositions: 4,
                maxActiveExposureUsdc: 20,
                signalMarketScope: 'all',
                signalWeakThresholdUsdc: 1,
                signalNormalThresholdUsdc: 2,
                signalStrongThresholdUsdc: 3,
                signalWeakTicketUsdc: 1,
                signalNormalTicketUsdc: 2,
                signalStrongTicketUsdc: 3,
                paperInitialBalance: 1000,
                clobHttpUrl: 'https://clob.polymarket.com',
                clobWsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
                userWsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
                dataApiUrl: 'https://data-api.polymarket.com',
                gammaApiUrl: 'https://gamma-api.polymarket.com',
                rpcUrl: 'https://polygon.drpc.org',
                marketWsReconnectMs: 1000,
                userWsReconnectMs: 1000,
                wsHeartbeatMs: 1000,
                marketBookStaleMs: 2500,
                marketWsBootstrapWaitMs: 750,
                orderConfirmationTimeoutMs: 1000,
                orderConfirmationPollMs: 1000,
                orderConfirmationBlocks: 1,
                liveConfirmTimeoutMs: 1000,
                liveReconcileAfterTimeoutMs: 1000,
                liveOrderMinIntervalMs: 100,
                maxSlippageBps: 100,
                maxOrderUsdc: 10,
                buyDustResidualMode: 'trim',
                relayerTxType: 'SAFE',
                usdcContractAddress: '0x0000000000000000000000000000000000000001',
                ctfContractAddress: '0x0000000000000000000000000000000000000002',
                autoRedeemEnabled: false,
                autoRedeemIntervalMs: 1000,
                autoRedeemMaxConditionsPerRun: 1,
            },
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
            stores: {
                sourceEvents: {
                    upsertMany: jest.fn(),
                    claimDueRetries: jest.fn(),
                    markConfirmed: jest.fn(async () => undefined),
                    markSkipped: jest.fn(async () => undefined),
                    markRetry: jest.fn(async () => undefined),
                    markFailed: jest.fn(async () => undefined),
                    skipOutstandingByCondition: jest.fn(async () => 0),
                },
                executions: {
                    save: jest.fn(async (record) => record),
                },
                settlementTasks: {
                    touchFromEvent: jest.fn(async () => undefined),
                    claimDue: jest.fn(),
                    markSettled: jest.fn(),
                    markClosed: jest.fn(),
                    markRetry: jest.fn(),
                },
            },
            gateways: {
                monitor: {} as never,
                trading: {} as never,
                settlement: {} as never,
            },
        },
        state: {},
        startedAt: Date.now(),
        now: () => Date.now(),
        ...overrides,
    }) as unknown as NodeContext;

describe('PersistExecutionNode', () => {
    it('聚合买单部分成交时会拆分 confirmed 与 retry', async () => {
        const event1 = buildEvent('buy-01');
        const event2 = buildEvent('buy-02');
        const event3 = buildEvent('buy-03');
        const ctx = buildContext({
            state: {
                sourceEvent: {
                    ...event1,
                    _id: undefined,
                    activityKey: 'bundle:asset-1:0.54:1',
                    usdcSize: 3,
                    raw: {
                        aggregatedBuyBundle: true,
                        sourceTradeCount: 3,
                    },
                },
                sourceEvents: [event1, event2, event3],
                sizingDecision: {
                    status: 'ready',
                    requestedUsdc: 3.6,
                    reason: '',
                    note: '固定金额策略 3.6000 USDC',
                },
                executionResult: {
                    status: 'confirmed',
                    reason: '',
                    requestedUsdc: 3.6,
                    requestedSize: 0,
                    executedUsdc: 2.4,
                    executedSize: 2.4 / 0.54,
                    executionPrice: 0.54,
                    orderIds: ['order-1'],
                    transactionHashes: ['tx-1'],
                    confirmedAt: Date.now(),
                    metadata: {
                        bundlePlannedCount: 3,
                        bundleExecutedCount: 2,
                    },
                },
                policyTrail: ['bundle:adjacent_buy'],
            },
        });

        const node = new PersistExecutionNode();
        const result = await node.doAction(ctx as never);

        expect(result.status).toBe('success');
        expect(ctx.runtime.stores.executions.save).toHaveBeenCalledTimes(3);
        const savedStatuses = (ctx.runtime.stores.executions.save as jest.Mock).mock.calls.map(
            (call) => (call[0] as { status: string }).status
        );
        expect(savedStatuses).toEqual(['confirmed', 'confirmed', 'retry']);
        expect(ctx.runtime.stores.sourceEvents.markConfirmed).toHaveBeenCalledTimes(2);
        expect(ctx.runtime.stores.sourceEvents.markRetry).toHaveBeenCalledTimes(1);
        expect(ctx.runtime.stores.sourceEvents.markRetry).toHaveBeenLastCalledWith(
            String(event3._id),
            '聚合买单仅部分成交，剩余批次稍后重试',
            expect.any(Number),
            1000
        );
    });

    it('重试次数超限时会直接落 failed', async () => {
        const event = buildEvent('buy-99', 2);
        const ctx = buildContext({
            state: {
                sourceEvent: event,
                sourceEvents: [event],
                executionResult: {
                    status: 'retry',
                    reason: 'Cloudflare 限流',
                    requestedUsdc: 1.2,
                    requestedSize: 1.2 / 0.54,
                    executedUsdc: 0,
                    executedSize: 0,
                    executionPrice: 0.54,
                    orderIds: [],
                    transactionHashes: [],
                },
            },
        });

        const node = new PersistExecutionNode();
        const result = await node.doAction(ctx as never);

        expect(result.status).toBe('fail');
        expect(ctx.runtime.stores.sourceEvents.markRetry).not.toHaveBeenCalled();
        expect(ctx.runtime.stores.sourceEvents.markFailed).toHaveBeenCalledTimes(1);
        expect(
            (
                (ctx.runtime.stores.executions.save as jest.Mock).mock.calls[0]?.[0] as {
                    status: string;
                }
            ).status
        ).toBe('failed');
    });
});
