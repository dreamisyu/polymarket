import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PolymarketMonitorGateway } from '../infrastructure/monitor/polymarketMonitorGateway';
import type { SourceActivityRecord, UserPositionRecord } from '../infrastructure/polymarket/dto';

jest.mock('../infrastructure/polymarket/api', () => ({
    __esModule: true,
    fetchSourceActivities: jest.fn(),
    fetchUserPositions: jest.fn(),
}));

jest.mock('../infrastructure/chain/wallet', () => ({
    __esModule: true,
    getUsdcBalance: jest.fn(),
}));

jest.mock('../infrastructure/db/models', () => ({
    __esModule: true,
    getMonitorCursorModel: jest.fn(),
}));

const { fetchSourceActivities, fetchUserPositions } = jest.requireMock(
    '../infrastructure/polymarket/api'
) as {
    fetchSourceActivities: jest.MockedFunction<
        (
            params: { start: number; end: number; limit: number },
            wallet: string,
            config: { dataApiUrl: string }
        ) => Promise<SourceActivityRecord[] | null>
    >;
    fetchUserPositions: jest.MockedFunction<
        (wallet: string, config: { dataApiUrl: string }) => Promise<UserPositionRecord[] | null>
    >;
};

const { getUsdcBalance } = jest.requireMock('../infrastructure/chain/wallet') as {
    getUsdcBalance: jest.MockedFunction<
        (address: string, config: { rpcUrl: string; usdcContractAddress: string }) => Promise<number>
    >;
};

const { getMonitorCursorModel } = jest.requireMock('../infrastructure/db/models') as {
    getMonitorCursorModel: jest.MockedFunction<(scopeKey: string) => unknown>;
};

const buildConfig = (strategyKind: 'fixed_amount' | 'proportional' | 'signal' = 'fixed_amount') =>
    ({
        runMode: 'live',
        strategyKind,
        targetWallet: '0xd9013df863c1ba932780857b020dfdeacedf8e14',
        scopeKey: 'scope',
        monitorInitialLookbackMs: 5_000,
        monitorOverlapMs: 1_000,
        activitySyncLimit: 100,
        snapshotStaleAfterMs: 60_000,
        dataApiUrl: 'https://data-api.polymarket.com',
        rpcUrl: 'https://polygon.drpc.org',
        usdcContractAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    }) as never;

const buildActivity = (): SourceActivityRecord => ({
    activityKey: 'activity-1',
    proxyWallet: '0xtarget',
    timestamp: 1_774_709_615,
    type: 'TRADE',
    side: 'BUY',
    transactionHash: '0xhash',
    conditionId: '0xcondition',
    asset: 'asset-1',
    outcome: 'Yes',
    outcomeIndex: 0,
    title: 'market-1',
    slug: 'market-1',
    eventSlug: 'event-1',
    price: 0.42,
    size: 10,
    usdcSize: 4.2,
});

describe('PolymarketMonitorGateway', () => {
    const Cursor = {
        findOne: jest.fn(),
        updateOne: jest.fn(),
    };
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        Cursor.findOne.mockReturnValue({
            lean: async () => null,
        });
        Cursor.updateOne.mockImplementation(async () => undefined);
        getMonitorCursorModel.mockReturnValue(Cursor);
        fetchSourceActivities.mockResolvedValue([buildActivity()]);
        fetchUserPositions.mockResolvedValue([]);
    });

    it('fixed_amount 策略在目标钱包余额读取失败时会降级为 PARTIAL 快照', async () => {
        getUsdcBalance.mockRejectedValueOnce(new Error('rpc down'));

        const gateway = new PolymarketMonitorGateway({
            config: buildConfig('fixed_amount'),
            logger: logger as never,
        });

        const result = await gateway.syncOnce();

        expect(result.events).toHaveLength(1);
        expect(result.events[0]?.snapshotStatus).toBe('PARTIAL');
        expect(result.events[0]?.sourceSnapshotReason).toContain('监控轮次缺少源账户余额或持仓');
        expect(logger.warn).toHaveBeenCalledWith(
            {
                err: expect.any(Error),
                wallet: '0xd9013df863c1ba932780857b020dfdeacedf8e14',
                strategyKind: 'fixed_amount',
            },
            '监控阶段读取目标钱包 USDC 余额失败，已降级为 PARTIAL 快照'
        );
    });

    it('proportional 策略在目标钱包余额读取失败时仍会抛错', async () => {
        getUsdcBalance.mockRejectedValueOnce(new Error('rpc down'));

        const gateway = new PolymarketMonitorGateway({
            config: buildConfig('proportional'),
            logger: logger as never,
        });

        await expect(gateway.syncOnce()).rejects.toThrow('rpc down');
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
