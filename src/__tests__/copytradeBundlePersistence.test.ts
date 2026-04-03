import { describe, expect, it, jest } from '@jest/globals';
import type { BundlePersistenceItem, SourceTradeEvent } from '@domain';
import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import { PersistExecutionNode } from '@domain/nodes/copytrade/PersistExecutionNode';
import { buildTestConfig } from '@/__tests__/testFactories';

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
            config: buildTestConfig({
                maxRetryCount: 2,
                fixedTradeAmountUsdc: 1.2,
                maxActiveExposureUsdc: 20,
                autoRedeemEnabled: false,
                autoRedeemMaxConditionsPerRun: 1,
            }),
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
            workflowEngine: {} as never,
            stores: {
                sourceEvents: {
                    upsertMany: jest.fn(),
                    claimDueRetries: jest.fn(),
                    markProcessing: jest.fn(async () => undefined),
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

const buildBundleItems = (items: BundlePersistenceItem[]) => ({
    bundle: {
        items,
    },
});

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
                    persistenceContext: buildBundleItems([
                        {
                            activityKey: event1.activityKey,
                            requestedUsdc: 1.2,
                            requestedSize: 1.2 / 0.54,
                            submittedUsdc: 1.2,
                            submittedSize: 1.2 / 0.54,
                            deferredReason: '聚合买单仅部分成交，剩余批次稍后重试',
                        },
                        {
                            activityKey: event2.activityKey,
                            requestedUsdc: 1.2,
                            requestedSize: 1.2 / 0.54,
                            submittedUsdc: 1.2,
                            submittedSize: 1.2 / 0.54,
                            deferredReason: '聚合买单仅部分成交，剩余批次稍后重试',
                        },
                        {
                            activityKey: event3.activityKey,
                            requestedUsdc: 1.2,
                            requestedSize: 1.2 / 0.54,
                            submittedUsdc: 0,
                            submittedSize: 0,
                            deferredReason: '聚合买单仅部分成交，剩余批次稍后重试',
                        },
                    ]),
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

    it('默认持久化规划器支持非 fixed_amount 的 bundle 明细拆分', async () => {
        const event1 = buildEvent('signal-01');
        const event2 = buildEvent('signal-02');
        const ctx = buildContext({
            workflowId: 'copytrade:signal:bundle-1',
            strategyKind: 'signal',
            runtime: {
                ...(buildContext().runtime as NodeContext['runtime']),
                config: buildTestConfig({
                    strategyKind: 'signal',
                    maxRetryCount: 2,
                    autoRedeemEnabled: false,
                    autoRedeemMaxConditionsPerRun: 1,
                }),
            },
            state: {
                sourceEvent: {
                    ...event1,
                    _id: undefined,
                    activityKey: 'bundle:signal:1',
                },
                sourceEvents: [event1, event2],
                executionResult: {
                    status: 'submitted',
                    reason: '订单已提交，等待后台确认',
                    requestedUsdc: 8,
                    requestedSize: 16,
                    executedUsdc: 0,
                    executedSize: 0,
                    executionPrice: 0.5,
                    orderIds: ['order-1'],
                    transactionHashes: ['tx-1'],
                    persistenceContext: buildBundleItems([
                        {
                            activityKey: event1.activityKey,
                            requestedUsdc: 5,
                            requestedSize: 10,
                            submittedUsdc: 5,
                            submittedSize: 10,
                        },
                        {
                            activityKey: event2.activityKey,
                            requestedUsdc: 3,
                            requestedSize: 6,
                            submittedUsdc: 0,
                            submittedSize: 0,
                            deferredReason: '等待下一轮信号补单',
                        },
                    ]),
                },
            },
        });

        const node = new PersistExecutionNode();
        const result = await node.doAction(ctx as never);

        expect(result.status).toBe('success');
        const savedStatuses = (ctx.runtime.stores.executions.save as jest.Mock).mock.calls.map(
            (call) => (call[0] as { status: string }).status
        );
        expect(savedStatuses).toEqual(['submitted', 'retry']);
        expect(ctx.runtime.stores.sourceEvents.markProcessing).toHaveBeenCalledTimes(1);
        expect(ctx.runtime.stores.sourceEvents.markRetry).toHaveBeenCalledTimes(1);
        expect(ctx.runtime.stores.sourceEvents.markRetry).toHaveBeenLastCalledWith(
            String(event2._id),
            '等待下一轮信号补单',
            expect.any(Number),
            1000
        );
    });
});
