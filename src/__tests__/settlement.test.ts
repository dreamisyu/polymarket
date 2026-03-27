import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import type { NodeContext } from '../domain/nodes/kernel/NodeContext';
import { SettlementSweepNode } from '../domain/nodes/settlement/SettlementSweepNode';
import { PaperSettlementGateway } from '../infrastructure/settlement/paperSettlementGateway';
import type { PortfolioSnapshot, PositionSnapshot } from '../domain';
import type {
    LedgerStore,
    Runtime,
    SettlementTaskStore,
    SourceEventStore,
} from '../infrastructure/runtime/contracts';
import * as resolutionUtils from '../utils/resolution';

const buildRuntime = (overrides: Partial<Runtime> = {}): Runtime =>
    ({
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
            maxRetryCount: 3,
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
        } as never,
        stores: {
            sourceEvents: {} as never,
            executions: {} as never,
            settlementTasks: {} as never,
        },
        gateways: {
            monitor: {} as never,
            trading: {} as never,
            settlement: {} as never,
        },
        ...overrides,
    }) as Runtime;

const buildContext = (runtime: Runtime): NodeContext => ({
    workflowId: 'settlement:test',
    workflowKind: 'settlement',
    runMode: 'paper',
    runtime,
    state: {},
    startedAt: Date.now(),
    now: () => Date.now(),
});

describe('SettlementSweepNode', () => {
    it('单轮内持续处理到无任务为止', async () => {
        const runDue = jest
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const runtime = buildRuntime({
            gateways: {
                monitor: {} as never,
                trading: {} as never,
                settlement: { runDue } as never,
            },
        });

        const node = new SettlementSweepNode();
        const result = await node.doAction(buildContext(runtime));

        expect(runDue).toHaveBeenCalledTimes(3);
        expect(result.status).toBe('success');
        expect(result.reason).toBe('结算轮次执行完成，处理 2 个任务');
        expect(result.payload).toEqual({ handledCount: 2, maxTasksPerRun: 3 });
    });

    it('达到单轮上限后停止继续扫尾', async () => {
        const runDue = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
        const runtime = buildRuntime({
            config: {
                ...buildRuntime().config,
                settlementMaxTasksPerRun: 2,
            },
            gateways: {
                monitor: {} as never,
                trading: {} as never,
                settlement: { runDue } as never,
            },
        });

        const node = new SettlementSweepNode();
        const result = await node.doAction(buildContext(runtime));

        expect(runDue).toHaveBeenCalledTimes(2);
        expect(result.payload).toEqual({ handledCount: 2, maxTasksPerRun: 2 });
    });
});

describe('PaperSettlementGateway', () => {
    const fetchMarketResolutionSpy = jest.spyOn(resolutionUtils, 'fetchMarketResolution');
    const isResolvedMarketSpy = jest.spyOn(resolutionUtils, 'isResolvedMarket');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        fetchMarketResolutionSpy.mockReset();
        isResolvedMarketSpy.mockReset();
    });

    it('resolved 后会清理挂起事件并删除本地仓位', async () => {
        const settlementTask = {
            _id: '507f1f77bcf86cd799439011' as never,
            conditionId: 'condition-1',
            marketSlug: 'market-1',
            title: 'title-1',
        };
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

        const skipOutstandingByCondition = jest.fn(async () => 2);
        const claimDue = jest.fn(async () => settlementTask as never);
        const markClosed = jest.fn(async () => undefined);
        const markRetry = jest.fn(async () => undefined);
        const getPortfolio = jest.fn(async () => portfolio);
        const listPositions = jest.fn(async () => positions);
        const deletePosition = jest.fn(async () => undefined);
        const savePortfolio = jest.fn(async () => undefined);
        const sourceEvents: SourceEventStore = {
            upsertMany: async () => [],
            markConfirmed: async () => undefined,
            markSkipped: async () => undefined,
            markRetry: async () => undefined,
            markFailed: async () => undefined,
            skipOutstandingByCondition,
        };
        const settlementTasks: SettlementTaskStore = {
            touchFromEvent: async () => undefined,
            claimDue,
            markSettled: async () => undefined,
            markClosed,
            markRetry,
        };
        const ledgerStore: LedgerStore = {
            ensurePortfolio: async () => undefined,
            getPortfolio,
            listPositions,
            findPositionByAsset: async () => null,
            savePosition: async () => undefined,
            deletePosition,
            savePortfolio,
        };

        const gateway = new PaperSettlementGateway({
            config: buildRuntime().config,
            sourceEvents,
            settlementTasks,
            ledgerStore,
        });

        const handled = await gateway.runDue();

        expect(handled).toBe(true);
        expect(skipOutstandingByCondition).toHaveBeenCalledWith(
            'condition-1',
            expect.stringContaining('已停止未完成跟单并开始回收'),
            expect.any(Number)
        );
        expect(deletePosition).toHaveBeenCalledTimes(2);
        expect(deletePosition).toHaveBeenNthCalledWith(1, 'winner-asset');
        expect(deletePosition).toHaveBeenNthCalledWith(2, 'loser-asset');
        expect(savePortfolio).toHaveBeenCalledWith(
            expect.objectContaining({
                cashBalance: 110,
                realizedPnl: 0,
                openPositionCount: 1,
                positions: [expect.objectContaining({ asset: 'other-asset' })],
            })
        );
        expect(markClosed).toHaveBeenCalledWith(
            '507f1f77bcf86cd799439011',
            'Yes',
            expect.stringContaining('winner=Yes'),
            expect.any(Number)
        );
    });

    it('无到期任务时直接返回 false', async () => {
        const claimDue = jest.fn(async () => null);
        const gateway = new PaperSettlementGateway({
            config: buildRuntime().config,
            sourceEvents: {
                upsertMany: async () => [],
                markConfirmed: async () => undefined,
                markSkipped: async () => undefined,
                markRetry: async () => undefined,
                markFailed: async () => undefined,
                skipOutstandingByCondition: async () => 0,
            },
            settlementTasks: {
                touchFromEvent: async () => undefined,
                claimDue,
                markSettled: async () => undefined,
                markClosed: async () => undefined,
                markRetry: async () => undefined,
            },
            ledgerStore: {
                ensurePortfolio: async () => undefined,
                getPortfolio: async () => ({
                    cashBalance: 0,
                    realizedPnl: 0,
                    positionsMarketValue: 0,
                    totalEquity: 0,
                    activeExposureUsdc: 0,
                    openPositionCount: 0,
                    positions: [],
                }),
                listPositions: async () => [],
                findPositionByAsset: async () => null,
                savePosition: async () => undefined,
                deletePosition: async () => undefined,
                savePortfolio: async () => undefined,
            },
        });

        await expect(gateway.runDue()).resolves.toBe(false);
        expect(claimDue).toHaveBeenCalledTimes(1);
    });
});
