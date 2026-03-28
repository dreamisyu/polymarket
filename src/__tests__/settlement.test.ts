import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PortfolioSnapshot, PositionSnapshot, SettlementTask } from '../domain';
import type { NodeContext } from '../domain/nodes/kernel/NodeContext';
import { SettlementSweepNode } from '../domain/nodes/settlement/SettlementSweepNode';
import type {
    LedgerStore,
    Runtime,
    SettlementGateway,
    SettlementTaskStore,
    SourceEventStore,
    TradingGateway,
} from '../infrastructure/runtime/contracts';
import * as resolutionUtils from '../utils/resolution';

const fetchMarketResolutionSpy = jest.spyOn(resolutionUtils, 'fetchMarketResolution');
const isResolvedMarketSpy = jest.spyOn(resolutionUtils, 'isResolvedMarket');

const buildConfig = (overrides: Partial<Runtime['config']> = {}): Runtime['config'] => ({
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
    maxRetryCount: 3,
    copytradeDispatchConcurrency: 2,
    settlementIntervalMs: 1000,
    settlementMaxTasksPerRun: 3,
    fixedTradeAmountUsdc: 1,
    maxOpenPositions: 4,
    maxActiveExposureUsdc: 10,
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
    wsHeartbeatMs: 10_000,
    marketBookStaleMs: 2500,
    marketWsBootstrapWaitMs: 750,
    orderConfirmationTimeoutMs: 1000,
    orderConfirmationPollMs: 1000,
    orderConfirmationBlocks: 1,
    liveConfirmTimeoutMs: 1000,
    liveReconcileAfterTimeoutMs: 1000,
    liveOrderMinIntervalMs: 100,
    liveSettlementOnchainRedeemEnabled: true,
    maxSlippageBps: 100,
    maxOrderUsdc: 10,
    buyDustResidualMode: 'trim',
    relayerTxType: 'SAFE',
    usdcContractAddress: '0x0000000000000000000000000000000000000001',
    ctfContractAddress: '0x0000000000000000000000000000000000000002',
    autoRedeemEnabled: true,
    autoRedeemIntervalMs: 1000,
    autoRedeemMaxConditionsPerRun: 1,
    ...overrides,
});

const createSourceEventStore = (overrides: Partial<SourceEventStore> = {}): SourceEventStore => ({
    upsertMany: jest.fn(async () => []),
    claimDueRetries: jest.fn(async () => []),
    markConfirmed: jest.fn(async () => undefined),
    markSkipped: jest.fn(async () => undefined),
    markRetry: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
    skipOutstandingByCondition: jest.fn(async () => 0),
    ...overrides,
});

const createSettlementTaskStore = (
    overrides: Partial<SettlementTaskStore> = {}
): SettlementTaskStore => ({
    touchFromEvent: jest.fn(async () => undefined),
    claimDue: jest.fn(async () => null),
    markSettled: jest.fn(async () => undefined),
    markClosed: jest.fn(async () => undefined),
    markRetry: jest.fn(async () => undefined),
    ...overrides,
});

const emptyPortfolio: PortfolioSnapshot = {
    cashBalance: 0,
    realizedPnl: 0,
    positionsMarketValue: 0,
    totalEquity: 0,
    activeExposureUsdc: 0,
    openPositionCount: 0,
    positions: [],
};

const createLedgerStore = (overrides: Partial<LedgerStore> = {}): LedgerStore => ({
    ensurePortfolio: jest.fn(async () => undefined),
    getPortfolio: jest.fn(async () => emptyPortfolio),
    listPositions: jest.fn(async () => []),
    findPositionByAsset: jest.fn(async () => null),
    savePosition: jest.fn(async () => undefined),
    deletePosition: jest.fn(async () => undefined),
    savePortfolio: jest.fn(async () => undefined),
    ...overrides,
});

const createTradingGateway = (overrides: Partial<TradingGateway> = {}): TradingGateway => ({
    getPortfolioSnapshot: jest.fn(async () => emptyPortfolio),
    getPositionForEvent: jest.fn(async () => null),
    getMarketSnapshot: jest.fn(async () => null),
    listConditionPositions: jest.fn(async () => ({
        conditionId: 'condition-1',
        positions: [],
        mergeableSize: 0,
    })),
    executeTrade: jest.fn(async () => ({
        status: 'skipped' as const,
        reason: '',
        requestedUsdc: 0,
        requestedSize: 0,
        executedUsdc: 0,
        executedSize: 0,
        executionPrice: 0,
        orderIds: [],
        transactionHashes: [],
    })),
    executeMerge: jest.fn(async () => ({
        status: 'skipped' as const,
        reason: '',
        requestedUsdc: 0,
        requestedSize: 0,
        executedUsdc: 0,
        executedSize: 0,
        executionPrice: 0,
        orderIds: [],
        transactionHashes: [],
    })),
    ...overrides,
});

const createSettlementGateway = (
    overrides: Partial<SettlementGateway> = {}
): SettlementGateway => ({
    executeRedeem: jest.fn(async () => ({
        status: 'confirmed' as const,
        reason: 'redeem 已确认 tx=0xabc',
        transactionHashes: ['0xabc'],
        confirmedAt: Date.now(),
    })),
    ...overrides,
});

const buildRuntime = (
    params: {
        config?: Partial<Runtime['config']>;
        sourceEvents?: Partial<SourceEventStore>;
        settlementTasks?: Partial<SettlementTaskStore>;
        ledger?: Partial<LedgerStore>;
        trading?: Partial<TradingGateway>;
        settlement?: Partial<SettlementGateway>;
    } = {}
): Runtime => {
    const config = buildConfig(params.config);
    const sourceEvents = createSourceEventStore(params.sourceEvents);
    const settlementTasks = createSettlementTaskStore(params.settlementTasks);
    const trading = createTradingGateway(params.trading);
    const settlement = createSettlementGateway(params.settlement);

    return {
        config,
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        } as never,
        stores: {
            sourceEvents,
            executions: {
                save: jest.fn(async (record) => record),
            },
            settlementTasks,
            ledger: config.runMode === 'paper' ? createLedgerStore(params.ledger) : undefined,
        },
        gateways: {
            monitor: {} as never,
            trading,
            settlement,
        },
    } as Runtime;
};

const buildContext = (runtime: Runtime): NodeContext => ({
    workflowId: 'settlement:test',
    workflowKind: 'settlement',
    runMode: runtime.config.runMode,
    runtime,
    state: {},
    startedAt: Date.now(),
    now: () => Date.now(),
});

const resolvedTask = (overrides: Partial<SettlementTask> = {}): SettlementTask => ({
    _id: '507f1f77bcf86cd799439011' as never,
    conditionId: 'condition-1',
    title: 'title-1',
    marketSlug: 'market-1',
    status: 'pending',
    reason: '',
    retryCount: 0,
    lastCheckedAt: 0,
    claimedAt: 0,
    nextRetryAt: 0,
    winnerOutcome: '',
    ...overrides,
});

describe('SettlementSweepNode', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        fetchMarketResolutionSpy.mockReset();
        isResolvedMarketSpy.mockReset();
    });

    it('AUTO_REDEEM_ENABLED=false 时跳过结算工作流', async () => {
        const runtime = buildRuntime({
            config: {
                autoRedeemEnabled: false,
            },
        });

        const result = await new SettlementSweepNode().doAction(buildContext(runtime));

        expect(result.status).toBe('skip');
        expect(result.reason).toBe('AUTO_REDEEM_ENABLED=false，已跳过结算工作流');
        expect(runtime.stores.settlementTasks.claimDue).not.toHaveBeenCalled();
    });

    it('单轮内会持续处理到无任务为止', async () => {
        fetchMarketResolutionSpy.mockResolvedValue({
            conditionId: 'condition-1',
            marketSlug: 'market-1',
            marketUrl: '',
            resolvedStatus: 'resolved',
            winnerOutcome: 'Yes',
            title: 'title-1',
            updateDescription: '',
            source: 'clob',
            closed: true,
            acceptingOrders: false,
            active: false,
            archived: false,
        });
        isResolvedMarketSpy.mockReturnValue(true);

        const runtime = buildRuntime({
            settlementTasks: {
                claimDue: jest
                    .fn(async () => null)
                    .mockResolvedValueOnce(resolvedTask())
                    .mockResolvedValueOnce(
                        resolvedTask({
                            _id: '507f1f77bcf86cd799439012' as never,
                            conditionId: 'condition-2',
                            marketSlug: 'market-2',
                            title: 'title-2',
                        })
                    )
                    .mockResolvedValueOnce(null),
            },
        });

        const result = await new SettlementSweepNode().doAction(buildContext(runtime));

        expect(runtime.stores.settlementTasks.claimDue).toHaveBeenCalledTimes(3);
        expect(result.status).toBe('success');
        expect(result.payload).toEqual({
            handledCount: 2,
            closedCount: 2,
            settledCount: 0,
            retryCount: 0,
            maxTasksPerRun: 3,
        });
    });

    it('paper 模式 resolved 后会清理挂起事件并删除本地仓位', async () => {
        const portfolio: PortfolioSnapshot = {
            cashBalance: 100,
            realizedPnl: 0,
            positionsMarketValue: 30,
            totalEquity: 130,
            activeExposureUsdc: 30,
            openPositionCount: 3,
            positions: [],
        };
        const positions: PositionSnapshot[] = [
            {
                asset: 'winner-asset',
                conditionId: 'condition-1',
                outcome: 'Yes',
                outcomeIndex: 0,
                size: 10,
                avgPrice: 0.6,
                marketPrice: 1,
                marketValue: 10,
                costBasis: 6,
                realizedPnl: 0,
                redeemable: true,
                lastUpdatedAt: 1,
            },
            {
                asset: 'loser-asset',
                conditionId: 'condition-1',
                outcome: 'No',
                outcomeIndex: 1,
                size: 10,
                avgPrice: 0.4,
                marketPrice: 0,
                marketValue: 0,
                costBasis: 4,
                realizedPnl: 0,
                redeemable: true,
                lastUpdatedAt: 1,
            },
            {
                asset: 'other-asset',
                conditionId: 'condition-2',
                outcome: 'Yes',
                outcomeIndex: 0,
                size: 5,
                avgPrice: 0.5,
                marketPrice: 0.5,
                marketValue: 2.5,
                costBasis: 2.5,
                realizedPnl: 0,
                redeemable: false,
                lastUpdatedAt: 1,
            },
        ];
        fetchMarketResolutionSpy.mockResolvedValue({
            conditionId: 'condition-1',
            marketSlug: 'market-1',
            marketUrl: '',
            resolvedStatus: 'resolved',
            winnerOutcome: 'Yes',
            title: 'title-1',
            updateDescription: '',
            source: 'clob',
            closed: true,
            acceptingOrders: false,
            active: false,
            archived: false,
        });
        isResolvedMarketSpy.mockReturnValue(true);

        const runtime = buildRuntime({
            settlementTasks: {
                claimDue: jest
                    .fn(async () => null)
                    .mockResolvedValueOnce(resolvedTask())
                    .mockResolvedValueOnce(null),
            },
            sourceEvents: {
                skipOutstandingByCondition: jest.fn(async () => 2),
            },
            ledger: {
                getPortfolio: jest.fn(async () => portfolio),
                listPositions: jest.fn(async () => positions),
                deletePosition: jest.fn(async () => undefined),
                savePortfolio: jest.fn(async () => undefined),
            },
        });

        await new SettlementSweepNode().doAction(buildContext(runtime));

        expect(runtime.stores.sourceEvents.skipOutstandingByCondition).toHaveBeenCalledWith(
            'condition-1',
            expect.stringContaining('已停止未完成跟单并开始结算'),
            expect.any(Number)
        );
        expect(runtime.stores.ledger?.deletePosition).toHaveBeenCalledTimes(2);
        expect(runtime.stores.ledger?.savePortfolio).toHaveBeenCalledWith(
            expect.objectContaining({
                cashBalance: 110,
                realizedPnl: 0,
                openPositionCount: 1,
                positions: [expect.objectContaining({ asset: 'other-asset' })],
            })
        );
        expect(runtime.stores.settlementTasks.markClosed).toHaveBeenCalledWith(
            '507f1f77bcf86cd799439011',
            'Yes',
            expect.stringContaining('winner=Yes'),
            expect.any(Number)
        );
    });

    it('live 模式禁用链上回收时会直接 close 且不调用 executeRedeem', async () => {
        fetchMarketResolutionSpy.mockResolvedValue({
            conditionId: 'condition-1',
            marketSlug: 'market-1',
            marketUrl: '',
            resolvedStatus: 'resolved',
            winnerOutcome: 'Yes',
            title: 'title-1',
            updateDescription: '',
            source: 'clob',
            closed: true,
            acceptingOrders: false,
            active: false,
            archived: false,
        });
        isResolvedMarketSpy.mockReturnValue(true);

        const executeRedeem = jest.fn(async () => ({
            status: 'confirmed' as const,
            reason: 'redeem 已确认 tx=0xabc',
            transactionHashes: ['0xabc'],
        }));
        const runtime = buildRuntime({
            config: {
                runMode: 'live',
                liveSettlementOnchainRedeemEnabled: false,
            },
            settlementTasks: {
                claimDue: jest
                    .fn(async () => null)
                    .mockResolvedValueOnce(resolvedTask())
                    .mockResolvedValueOnce(null),
            },
            trading: {
                listConditionPositions: jest.fn(async () => ({
                    conditionId: 'condition-1',
                    mergeableSize: 0,
                    positions: [
                        {
                            asset: 'winner-asset',
                            conditionId: 'condition-1',
                            outcome: 'Yes',
                            outcomeIndex: 0,
                            size: 10,
                            avgPrice: 0.6,
                            marketPrice: 1,
                            marketValue: 10,
                            costBasis: 6,
                            realizedPnl: 0,
                            redeemable: true,
                        },
                    ],
                })),
            },
            settlement: {
                executeRedeem,
            },
        });

        await new SettlementSweepNode().doAction(buildContext(runtime));

        expect(executeRedeem).not.toHaveBeenCalled();
        expect(runtime.stores.settlementTasks.markClosed).toHaveBeenCalledWith(
            '507f1f77bcf86cd799439011',
            'Yes',
            expect.stringContaining('配置禁用链上回收，未发送 redeem tx'),
            expect.any(Number)
        );
    });

    it('live 模式 resolved 但仓位尚未 redeemable 时标记 settled', async () => {
        fetchMarketResolutionSpy.mockResolvedValue({
            conditionId: 'condition-1',
            marketSlug: 'market-1',
            marketUrl: '',
            resolvedStatus: 'resolved',
            winnerOutcome: 'Yes',
            title: 'title-1',
            updateDescription: '',
            source: 'clob',
            closed: true,
            acceptingOrders: false,
            active: false,
            archived: false,
        });
        isResolvedMarketSpy.mockReturnValue(true);

        const runtime = buildRuntime({
            config: {
                runMode: 'live',
            },
            settlementTasks: {
                claimDue: jest
                    .fn(async () => null)
                    .mockResolvedValueOnce(resolvedTask())
                    .mockResolvedValueOnce(null),
            },
            trading: {
                listConditionPositions: jest.fn(async () => ({
                    conditionId: 'condition-1',
                    mergeableSize: 0,
                    positions: [
                        {
                            asset: 'winner-asset',
                            conditionId: 'condition-1',
                            outcome: 'Yes',
                            outcomeIndex: 0,
                            size: 10,
                            avgPrice: 0.6,
                            marketPrice: 1,
                            marketValue: 10,
                            costBasis: 6,
                            realizedPnl: 0,
                            redeemable: false,
                        },
                    ],
                })),
            },
        });

        const result = await new SettlementSweepNode().doAction(buildContext(runtime));

        expect(result.payload).toEqual({
            handledCount: 1,
            closedCount: 0,
            settledCount: 1,
            retryCount: 0,
            maxTasksPerRun: 3,
        });
        expect(runtime.stores.settlementTasks.markSettled).toHaveBeenCalledWith(
            '507f1f77bcf86cd799439011',
            'Yes',
            expect.stringContaining('等待下轮补清'),
            expect.any(Number),
            1000
        );
        expect(runtime.gateways.settlement.executeRedeem).not.toHaveBeenCalled();
    });
});
