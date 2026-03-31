import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@polymarket/clob-client', () => ({
    __esModule: true,
    Side: {
        BUY: 'BUY',
        SELL: 'SELL',
    },
    TickSize: {},
}));

import { PolymarketMarketBookFeed } from '@infrastructure/polymarket/marketBookFeed';
import { PolymarketUserExecutionFeed } from '@infrastructure/polymarket/userExecutionFeed';

class MockWebSocket {
    static instances: MockWebSocket[] = [];

    readonly url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    readonly sent: string[] = [];

    constructor(url: string) {
        this.url = url;
        MockWebSocket.instances.push(this);
    }

    send(data: string) {
        this.sent.push(data);
    }

    close() {
        this.readyState = 3;
        this.onclose?.();
    }

    open() {
        this.readyState = 1;
        this.onopen?.();
    }

    emit(data: unknown) {
        this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }

    static reset() {
        MockWebSocket.instances = [];
    }
}

const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
} as never;

describe('PolymarketMarketBookFeed', () => {
    let feed: PolymarketMarketBookFeed | null = null;

    beforeEach(() => {
        jest.useRealTimers();
        MockWebSocket.reset();
        (globalThis as unknown as { WebSocket?: typeof MockWebSocket }).WebSocket = MockWebSocket;
    });

    afterEach(() => {
        feed?.close();
        feed = null;
        jest.useRealTimers();
        delete (globalThis as unknown as { WebSocket?: typeof MockWebSocket }).WebSocket;
    });

    it('优先消费 websocket 首包盘口', async () => {
        jest.useFakeTimers();
        const fetchBook = jest.fn(async () => ({
            market: 'market-1',
            asset_id: 'asset-1',
            hash: 'hash-1',
            timestamp: Date.now().toString(),
            bids: [],
            asks: [],
            min_order_size: '5',
            tick_size: '0.01',
            neg_risk: false,
            last_trade_price: '0.4',
        }));
        feed = new PolymarketMarketBookFeed({
            config: {
                clobWsUrl: 'wss://example.com/market',
                marketWsReconnectMs: 100,
                wsHeartbeatMs: 1000,
                marketBookStaleMs: 5000,
                marketWsBootstrapWaitMs: 25,
            },
            logger,
            fetchBook: fetchBook as never,
        });

        const snapshotPromise = feed.getSnapshot('asset-1');
        const socket = MockWebSocket.instances[0];
        expect(socket).toBeDefined();
        if (!socket) {
            throw new Error('缺少市场 websocket mock 实例');
        }

        socket.open();
        expect(socket.url).toBe('wss://example.com/market');
        expect(JSON.parse(socket.sent[0] || '{}')).toEqual({
            type: 'market',
            assets_ids: ['asset-1'],
            custom_feature_enabled: true,
        });
        socket.emit({
            event_type: 'book',
            asset_id: 'asset-1',
            bids: [{ price: '0.42', size: '100' }],
            asks: [{ price: '0.43', size: '120' }],
            min_order_size: '5',
            tick_size: '0.01',
            neg_risk: true,
            last_trade_price: '0.425',
            timestamp: Date.now(),
        });

        await jest.advanceTimersByTimeAsync(25);
        const snapshot = await snapshotPromise;

        expect(snapshot?.assetId).toBe('asset-1');
        expect(snapshot?.bids[0]?.price).toBe(0.42);
        expect(snapshot?.asks[0]?.price).toBe(0.43);
        expect(fetchBook).not.toHaveBeenCalled();
    });

    it('并发获取同一资产快照时只回退一次 HTTP 拉单', async () => {
        delete (globalThis as unknown as { WebSocket?: typeof MockWebSocket }).WebSocket;
        const fetchBook = jest.fn(async () => ({
            market: 'market-1',
            asset_id: 'asset-1',
            timestamp: Date.now().toString(),
            bids: [{ price: '0.41', size: '100' }],
            asks: [{ price: '0.42', size: '120' }],
            min_order_size: '5',
            tick_size: '0.01',
            neg_risk: false,
            last_trade_price: '0.415',
        }));
        feed = new PolymarketMarketBookFeed({
            config: {
                clobWsUrl: 'wss://example.com/market',
                marketWsReconnectMs: 100,
                wsHeartbeatMs: 1000,
                marketBookStaleMs: 5000,
                marketWsBootstrapWaitMs: 25,
            },
            logger,
            fetchBook: fetchBook as never,
        });

        const [left, right] = await Promise.all([
            feed.getSnapshot('asset-1'),
            feed.getSnapshot('asset-1'),
        ]);

        expect(fetchBook).toHaveBeenCalledTimes(1);
        expect(left).toEqual(right);
        expect(left?.asks[0]?.price).toBe(0.42);
    });
});

describe('PolymarketUserExecutionFeed', () => {
    let feed: PolymarketUserExecutionFeed | null = null;

    beforeEach(() => {
        jest.useRealTimers();
        MockWebSocket.reset();
        (globalThis as unknown as { WebSocket?: typeof MockWebSocket }).WebSocket = MockWebSocket;
    });

    afterEach(() => {
        feed?.close();
        feed = null;
        jest.useRealTimers();
        delete (globalThis as unknown as { WebSocket?: typeof MockWebSocket }).WebSocket;
    });

    it('收到 CONFIRMED 回报后结束等待', async () => {
        feed = new PolymarketUserExecutionFeed({
            config: {
                userWsUrl: 'wss://example.com/user',
                userWsReconnectMs: 100,
                wsHeartbeatMs: 1000,
                liveConfirmTimeoutMs: 1000,
            },
            logger,
            creds: {
                key: 'key',
                secret: 'secret',
                passphrase: 'pass',
            },
        });

        const resultPromise = feed.waitForOrders({
            conditionId: 'condition-1',
            orderIds: ['order-1'],
        });

        const socket = MockWebSocket.instances[0];
        expect(socket).toBeDefined();
        if (!socket) {
            throw new Error('缺少用户 websocket mock 实例');
        }
        socket.open();
        expect(socket.url).toBe('wss://example.com/user');
        expect(JSON.parse(socket.sent[0] || '{}')).toEqual({
            auth: {
                apiKey: 'key',
                secret: 'secret',
                passphrase: 'pass',
            },
            markets: ['condition-1'],
            type: 'user',
        });
        socket.emit({
            event_type: 'trade',
            taker_order_id: 'order-1',
            status: 'CONFIRMED',
            timestamp: Date.now(),
        });

        const result = await resultPromise;
        expect(result.confirmationStatus).toBe('CONFIRMED');
        expect(result.status).toBe('CONFIRMED');
    });
});
