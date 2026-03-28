import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SourceTradeEvent } from '../domain';
import { confirmTransactionHashes } from '../infrastructure/chain/confirm';
import { submitRedeemPositions } from '../infrastructure/chain/ctf';
import { createLiveClobClient } from '../infrastructure/polymarket/clobClient';
import { fetchUserPositions } from '../infrastructure/polymarket/api';
import { LiveSettlementGateway } from '../infrastructure/settlement/liveSettlementGateway';
import { getUsdcBalance } from '../infrastructure/chain/wallet';
import { LiveTradingGateway } from '../infrastructure/trading/liveTradingGateway';

jest.mock('@polymarket/clob-client', () => {
    const instances: Array<{
        args: unknown[];
        deriveApiKey: jest.Mock;
        createApiKey: jest.Mock;
        getOrderBook: jest.Mock;
    }> = [];

    class MockClobClient {
        static deriveApiKeyResult: unknown = {
            key: 'derived-key',
            secret: 'derived-secret',
            passphrase: 'derived-pass',
        };
        static createApiKeyResult: unknown = {
            key: 'created-key',
            secret: 'created-secret',
            passphrase: 'created-pass',
        };

        readonly args: unknown[];
        readonly deriveApiKey = jest.fn(async () => MockClobClient.deriveApiKeyResult);
        readonly createApiKey = jest.fn(async () => MockClobClient.createApiKeyResult);
        readonly getOrderBook = jest.fn();

        constructor(...args: unknown[]) {
            this.args = args;
            instances.push(this);
        }

        static reset() {
            instances.length = 0;
            MockClobClient.deriveApiKeyResult = {
                key: 'derived-key',
                secret: 'derived-secret',
                passphrase: 'derived-pass',
            };
            MockClobClient.createApiKeyResult = {
                key: 'created-key',
                secret: 'created-secret',
                passphrase: 'created-pass',
            };
        }
    }

    return {
        __esModule: true,
        ClobClient: MockClobClient,
        Chain: {
            POLYGON: 'POLYGON',
        },
        OrderType: {
            FOK: 'FOK',
        },
        Side: {
            BUY: 'BUY',
            SELL: 'SELL',
        },
        SignatureType: {
            POLY_PROXY: 'POLY_PROXY',
            POLY_GNOSIS_SAFE: 'POLY_GNOSIS_SAFE',
        },
        TickSize: {},
        __mock: {
            instances,
            MockClobClient,
        },
    };
});

jest.mock('ethers', () => ({
    __esModule: true,
    Wallet: class MockWallet {
        readonly address = '0xwallet';

        constructor(readonly privateKey: string) {}

        async signTypedData() {
            return 'signature';
        }
    },
}));

jest.mock('../infrastructure/polymarket/api', () => ({
    __esModule: true,
    fetchUserPositions: jest.fn(),
}));

jest.mock('../infrastructure/chain/wallet', () => ({
    __esModule: true,
    getUsdcBalance: jest.fn(),
}));

jest.mock('../infrastructure/chain/confirm', () => ({
    __esModule: true,
    confirmTransactionHashes: jest.fn(),
}));

jest.mock('../infrastructure/chain/ctf', () => ({
    __esModule: true,
    submitConditionMerge: jest.fn(),
    submitRedeemPositions: jest.fn(),
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

const clobClientMock = (
    jest.requireMock('@polymarket/clob-client') as {
        __mock: {
            instances: Array<{
                args: unknown[];
                deriveApiKey: jest.Mock;
                createApiKey: jest.Mock;
            }>;
            MockClobClient: {
                deriveApiKeyResult: unknown;
                createApiKeyResult: unknown;
                reset: () => void;
            };
        };
    }
).__mock;

const mockedFetchUserPositions = fetchUserPositions as jest.MockedFunction<
    typeof fetchUserPositions
>;
const mockedGetUsdcBalance = getUsdcBalance as jest.MockedFunction<typeof getUsdcBalance>;
const mockedConfirmTransactionHashes = confirmTransactionHashes as jest.MockedFunction<
    typeof confirmTransactionHashes
>;
const mockedSubmitRedeemPositions = submitRedeemPositions as jest.MockedFunction<
    typeof submitRedeemPositions
>;

const buildLiveConfig = (overrides: Record<string, unknown> = {}) => ({
    runMode: 'live' as const,
    strategyKind: 'fixed_amount' as const,
    sourceWallet: '0xsource',
    targetWallet: '0xtarget',
    mongoUri: 'mongodb://localhost/test',
    scopeKey: '0xsource:0xtarget:live:fixed_amount',
    monitorIntervalMs: 1000,
    monitorInitialLookbackMs: 1000,
    monitorOverlapMs: 1000,
    activitySyncLimit: 100,
    activityAdjacentMergeWindowMs: 1000,
    snapshotStaleAfterMs: 1000,
    retryBackoffMs: 1000,
    maxRetryCount: 3,
    copytradeDispatchConcurrency: 2,
    copytradeProcessingLeaseMs: 300_000,
    settlementIntervalMs: 1000,
    settlementMaxTasksPerRun: 8,
    fixedTradeAmountUsdc: 1.2,
    maxOpenPositions: 4,
    maxActiveExposureUsdc: 20,
    signalMarketScope: 'all' as const,
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
    marketWsBootstrapWaitMs: 10,
    orderConfirmationTimeoutMs: 1000,
    orderConfirmationPollMs: 100,
    orderConfirmationBlocks: 1,
    liveConfirmTimeoutMs: 1000,
    liveReconcileAfterTimeoutMs: 1000,
    liveOrderMinIntervalMs: 100,
    liveSettlementOnchainRedeemEnabled: true,
    maxSlippageBps: 100,
    maxOrderUsdc: 10,
    buyDustResidualMode: 'trim' as const,
    proxyWallet: '0xproxy',
    privateKey: 'a'.repeat(64),
    relayerUrl: 'https://relayer-v2.polymarket.com',
    relayerTxType: 'SAFE' as const,
    usdcContractAddress: '0x0000000000000000000000000000000000000001',
    ctfContractAddress: '0x0000000000000000000000000000000000000002',
    autoRedeemEnabled: true,
    autoRedeemIntervalMs: 1000,
    autoRedeemMaxConditionsPerRun: 2,
    ...overrides,
});

const buildBuyEvent = (activityKey: string): SourceTradeEvent => ({
    _id: '507f1f77bcf86cd799439011' as never,
    sourceWallet: '0xtarget',
    activityKey,
    timestamp: Date.now(),
    type: 'TRADE',
    side: 'BUY',
    action: 'buy',
    transactionHash: '0xhash',
    conditionId: '0xcondition',
    asset: 'asset-1',
    outcome: 'Yes',
    outcomeIndex: 0,
    title: 'market-1',
    slug: 'market-1',
    eventSlug: 'event-1',
    price: 0.5,
    size: 2,
    usdcSize: 2,
    executionIntent: 'EXECUTE',
    sourceBalanceAfterTrade: 10,
    sourceBalanceBeforeTrade: 12,
    sourcePositionSizeAfterTrade: 4,
    sourcePositionSizeBeforeTrade: 2,
    sourceConditionMergeableSizeAfterTrade: 0,
    sourceConditionMergeableSizeBeforeTrade: 0,
    sourceSnapshotCapturedAt: Date.now(),
    snapshotStatus: 'COMPLETE',
    sourceSnapshotReason: '',
    raw: {},
});

describe('createLiveClobClient', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clobClientMock.MockClobClient.reset();
    });

    it('优先派生 CLOB API key 并复用凭证', async () => {
        const session = await createLiveClobClient(buildLiveConfig());

        expect(clobClientMock.instances).toHaveLength(2);
        expect(clobClientMock.instances[0]?.deriveApiKey).toHaveBeenCalledTimes(1);
        expect(clobClientMock.instances[0]?.createApiKey).not.toHaveBeenCalled();
        expect(session.creds).toEqual(clobClientMock.MockClobClient.deriveApiKeyResult);
        expect(clobClientMock.instances[1]?.args[4]).toBe('POLY_GNOSIS_SAFE');
        expect(clobClientMock.instances[1]?.args[5]).toBe('0xproxy');
    });

    it('派生结果无效时会回退 createApiKey', async () => {
        clobClientMock.MockClobClient.deriveApiKeyResult = {
            key: '',
            secret: '',
            passphrase: '',
        };
        const session = await createLiveClobClient(
            buildLiveConfig({
                relayerTxType: 'PROXY',
            })
        );

        expect(clobClientMock.instances[0]?.createApiKey).toHaveBeenCalledTimes(1);
        expect(session.creds).toEqual(clobClientMock.MockClobClient.createApiKeyResult);
        expect(clobClientMock.instances[1]?.args[4]).toBe('POLY_PROXY');
    });
});

describe('LiveTradingGateway submission pacing', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedFetchUserPositions.mockResolvedValue([]);
        mockedGetUsdcBalance.mockResolvedValue(100);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('并发提交时会按最小间隔错峰下单', async () => {
        const submitTimestamps: number[] = [];
        const gateway = new LiveTradingGateway({
            config: buildLiveConfig({
                liveOrderMinIntervalMs: 50,
            }),
            logger: mockLogger as never,
            clobClient: {
                createAndPostMarketOrder: jest.fn(async () => {
                    submitTimestamps.push(Date.now());
                    return {
                        success: true,
                        orderID: `order-${submitTimestamps.length}`,
                        transactionsHashes: [],
                    };
                }),
            } as never,
            marketFeed: {
                ensureAsset: async () => undefined,
                getSnapshot: async () => ({
                    assetId: 'asset-1',
                    market: 'market-1',
                    bids: [{ price: 0.49, size: 100 }],
                    asks: [{ price: 0.5, size: 100 }],
                    minOrderSize: 5,
                    tickSize: '0.01' as never,
                    negRisk: false,
                    lastTradePrice: 0.5,
                    timestamp: Date.now(),
                }),
            },
            userExecutionFeed: {
                isAvailable: () => true,
                ensureMarket: async () => undefined,
                waitForOrders: async () => ({
                    confirmationStatus: 'CONFIRMED',
                    status: 'CONFIRMED',
                    reason: '',
                    confirmedAt: Date.now(),
                }),
            },
        });

        const first = gateway.executeTrade({
            sourceEvent: buildBuyEvent('buy-1'),
            requestedUsdc: 1.2,
            requestedSize: 2.4,
            orderAmount: 1.2,
            executionPrice: 0.5,
            side: 'BUY' as never,
            tickSize: '0.01' as never,
        });
        const second = gateway.executeTrade({
            sourceEvent: buildBuyEvent('buy-2'),
            requestedUsdc: 1.2,
            requestedSize: 2.4,
            orderAmount: 1.2,
            executionPrice: 0.5,
            side: 'BUY' as never,
            tickSize: '0.01' as never,
        });

        await Promise.all([first, second]);

        expect(submitTimestamps).toHaveLength(2);
        expect((submitTimestamps[1] || 0) - (submitTimestamps[0] || 0)).toBeGreaterThanOrEqual(45);
    });

    it('executeTrade 只执行领域已规划好的订单请求', async () => {
        const createAndPostMarketOrder = jest.fn(async () => ({
            success: true,
            orderID: 'order-1',
            transactionsHashes: [],
        }));
        const gateway = new LiveTradingGateway({
            config: buildLiveConfig(),
            logger: mockLogger as never,
            clobClient: {
                createAndPostMarketOrder,
            } as never,
            marketFeed: {
                ensureAsset: async () => undefined,
                getSnapshot: async () => null,
            },
            userExecutionFeed: {
                isAvailable: () => true,
                ensureMarket: async () => undefined,
                waitForOrders: async () => ({
                    confirmationStatus: 'CONFIRMED',
                    status: 'CONFIRMED',
                    reason: '',
                    confirmedAt: Date.now(),
                }),
            },
        });

        const result = await gateway.executeTrade({
            sourceEvent: {
                ...buildBuyEvent('bundle-buy-1'),
                activityKey: 'bundle:asset-1:0.5:1',
                usdcSize: 5,
                raw: {
                    aggregatedBuyBundle: true,
                    sourceTradeCount: 3,
                },
            },
            requestedUsdc: 3.6,
            requestedSize: 7.2,
            orderAmount: 2.4,
            executionPrice: 0.5,
            side: 'BUY' as never,
            tickSize: '0.01' as never,
            metadata: {
                bundlePlannedCount: 3,
                bundleExecutedCount: 2,
            },
        });

        expect(createAndPostMarketOrder).toHaveBeenCalledTimes(1);
        const firstOrder = (
            (createAndPostMarketOrder as jest.Mock).mock.calls as Array<[{ amount: number }]>
        )[0]?.[0];
        expect(firstOrder.amount).toBe(2.4);
        expect(result.status).toBe('confirmed');
        expect(result.requestedUsdc).toBeCloseTo(3.6, 6);
        expect(result.executedUsdc).toBeCloseTo(2.4, 6);
        expect(result.metadata).toEqual({
            bundlePlannedCount: 3,
            bundleExecutedCount: 2,
        });
    });
});

describe('LiveSettlementGateway', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedSubmitRedeemPositions.mockResolvedValue(
            '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
        );
        mockedConfirmTransactionHashes.mockResolvedValue({
            status: 'CONFIRMED',
            reason: '',
            confirmedAt: 123,
        } as never);
    });

    it('executeRedeem 会提交链上 redeem 并等待确认', async () => {
        const gateway = new LiveSettlementGateway({
            config: buildLiveConfig(),
            logger: mockLogger as never,
        });

        const result = await gateway.executeRedeem({
            conditionId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            positions: [
                {
                    asset: 'winner-asset',
                    conditionId:
                        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
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
            indexSets: [1n],
        });

        expect(mockedSubmitRedeemPositions).toHaveBeenCalledWith(
            {
                conditionId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                indexSets: [1n],
            },
            expect.objectContaining({
                privateKey: expect.any(String),
            })
        );
        expect(mockedConfirmTransactionHashes).toHaveBeenCalledWith(
            ['0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'],
            expect.any(Object),
            { timeoutMs: 1000 }
        );
        expect(result).toEqual({
            status: 'confirmed',
            reason: 'redeem 已确认 tx=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            transactionHashes: [
                '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            ],
            confirmedAt: 123,
        });
    });

    it('conditionId 非法时不会发送链上 redeem', async () => {
        const gateway = new LiveSettlementGateway({
            config: buildLiveConfig(),
            logger: mockLogger as never,
        });

        const result = await gateway.executeRedeem({
            conditionId: 'condition-1',
            positions: [],
            indexSets: [],
        });

        expect(mockedSubmitRedeemPositions).not.toHaveBeenCalled();
        expect(result).toEqual({
            status: 'failed',
            reason: 'conditionId 非法，无法提交 redeem',
            transactionHashes: [],
        });
    });
});
