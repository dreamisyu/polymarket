import type { OrderBookSummary, Side } from '@polymarket/clob-client';
import type { RuntimeConfig } from '@config/runtimeConfig';
import {
    buildMarketBookSnapshot,
    sortBookLevels,
    type MarketBookLevel,
    type MarketBookSnapshot,
} from '../../utils/executionPlanning';
import type { LoggerLike } from '@infrastructure/runtime/contracts';

interface RuntimeWebSocket {
    readyState: number;
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onerror: ((error: unknown) => void) | null;
    onmessage: ((event: { data: string }) => void) | null;
    send: (data: string) => void;
    close: () => void;
}

type RuntimeWebSocketConstructor = new (url: string) => RuntimeWebSocket;

type FetchBook = (assetId: string) => Promise<OrderBookSummary>;

type MarketBookMessage = {
    event_type?: string;
    asset_id?: string;
    market?: string;
    bids?: Array<{ price?: string | number; size?: string | number }>;
    asks?: Array<{ price?: string | number; size?: string | number }>;
    min_order_size?: string | number;
    tick_size?: string;
    neg_risk?: boolean;
    timestamp?: string | number;
    last_trade_price?: string | number;
    changes?: Array<{ side?: 'BUY' | 'SELL'; price?: string | number; size?: string | number }>;
    best_bid?: string | number;
    best_ask?: string | number;
};

const getWebSocketConstructor = () =>
    (globalThis as unknown as { WebSocket?: RuntimeWebSocketConstructor }).WebSocket;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const buySide = 'BUY' as Side;
const sellSide = 'SELL' as Side;

const normalizeLevel = (level: {
    price?: string | number;
    size?: string | number;
}): MarketBookLevel => ({
    price: Math.max(Number(level.price) || 0, 0),
    size: Math.max(Number(level.size) || 0, 0),
});

const toBookSnapshotPayload = (message: MarketBookMessage) => ({
    market: message.market,
    timestamp: message.timestamp,
    bids: (message.bids || []).map((level) => ({
        price: String(level.price ?? ''),
        size: String(level.size ?? ''),
    })),
    asks: (message.asks || []).map((level) => ({
        price: String(level.price ?? ''),
        size: String(level.size ?? ''),
    })),
    min_order_size: message.min_order_size,
    tick_size: message.tick_size,
    neg_risk: message.neg_risk,
    last_trade_price: message.last_trade_price,
});

export interface MarketBookFeed {
    ensureAsset(assetId: string): Promise<void>;
    getSnapshot(assetId: string): Promise<MarketBookSnapshot | null>;
}

export class PolymarketMarketBookFeed implements MarketBookFeed {
    private readonly config: Pick<
        RuntimeConfig,
        | 'clobWsUrl'
        | 'marketWsReconnectMs'
        | 'wsHeartbeatMs'
        | 'marketBookStaleMs'
        | 'marketWsBootstrapWaitMs'
    >;
    private readonly logger: LoggerLike;
    private readonly fetchBook: FetchBook;
    private readonly subscribedAssets = new Set<string>();
    private readonly snapshots = new Map<string, MarketBookSnapshot>();
    private readonly pendingLoads = new Map<string, Promise<MarketBookSnapshot | null>>();
    private ws: RuntimeWebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private opening = false;

    constructor(params: {
        config: Pick<
            RuntimeConfig,
            | 'clobWsUrl'
            | 'marketWsReconnectMs'
            | 'wsHeartbeatMs'
            | 'marketBookStaleMs'
            | 'marketWsBootstrapWaitMs'
        >;
        logger: LoggerLike;
        fetchBook: FetchBook;
    }) {
        this.config = params.config;
        this.logger = params.logger;
        this.fetchBook = params.fetchBook;
    }

    async ensureAsset(assetId: string) {
        const normalizedAssetId = String(assetId || '').trim();
        if (!normalizedAssetId) {
            return;
        }

        const alreadySubscribed = this.subscribedAssets.has(normalizedAssetId);
        this.subscribedAssets.add(normalizedAssetId);
        this.connect();
        if (!alreadySubscribed) {
            this.sendIncrementalSubscription([normalizedAssetId]);
        }
    }

    async getSnapshot(assetId: string): Promise<MarketBookSnapshot | null> {
        const normalizedAssetId = String(assetId || '').trim();
        if (!normalizedAssetId) {
            return null;
        }

        await this.ensureAsset(normalizedAssetId);
        const currentSnapshot = this.snapshots.get(normalizedAssetId);
        if (currentSnapshot && !this.isSnapshotStale(currentSnapshot)) {
            return currentSnapshot;
        }

        const pendingLoad = this.pendingLoads.get(normalizedAssetId);
        if (pendingLoad) {
            return pendingLoad;
        }

        let loadPromise: Promise<MarketBookSnapshot | null>;
        loadPromise = this.loadSnapshot(normalizedAssetId).finally(() => {
            if (this.pendingLoads.get(normalizedAssetId) === loadPromise) {
                this.pendingLoads.delete(normalizedAssetId);
            }
        });
        this.pendingLoads.set(normalizedAssetId, loadPromise);
        return loadPromise;
    }

    close() {
        this.subscribedAssets.clear();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopHeartbeat();
        const currentWs = this.ws;
        this.ws = null;
        this.opening = false;
        if (currentWs) {
            currentWs.close();
        }
    }

    private isAvailable() {
        return Boolean(getWebSocketConstructor());
    }

    private isSnapshotStale(snapshot: MarketBookSnapshot) {
        return Date.now() - snapshot.timestamp > this.config.marketBookStaleMs;
    }

    private connect() {
        const WebSocketConstructor = getWebSocketConstructor();
        if (!WebSocketConstructor || this.ws || this.opening) {
            return;
        }

        this.opening = true;
        const ws = new WebSocketConstructor(this.config.clobWsUrl);
        ws.onopen = () => {
            this.ws = ws;
            this.opening = false;
            this.sendInitialSubscription();
            this.startHeartbeat();
        };
        ws.onmessage = (event) => {
            this.handleMessage(event.data);
        };
        ws.onerror = (error) => {
            this.logger.error({ err: error }, '市场 websocket 异常');
        };
        ws.onclose = () => {
            this.ws = null;
            this.opening = false;
            this.stopHeartbeat();
            if (this.subscribedAssets.size > 0) {
                this.reconnect();
            }
        };
    }

    private reconnect() {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.config.marketWsReconnectMs);
    }

    private async loadSnapshot(assetId: string): Promise<MarketBookSnapshot | null> {
        if (this.isAvailable()) {
            await sleep(this.config.marketWsBootstrapWaitMs);
            const wsSnapshot = this.snapshots.get(assetId);
            if (wsSnapshot && !this.isSnapshotStale(wsSnapshot)) {
                return wsSnapshot;
            }
        }

        try {
            const orderBook = await this.fetchBook(assetId);
            const snapshot = buildMarketBookSnapshot(assetId, orderBook);
            this.snapshots.set(assetId, snapshot);
            return snapshot;
        } catch (error) {
            this.logger.error({ err: error }, `获取市场盘口失败 asset=${assetId}`);
            return this.snapshots.get(assetId) || null;
        }
    }

    private startHeartbeat() {
        if (this.heartbeatTimer) {
            return;
        }

        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) {
                this.ws.send('PING');
            }
        }, this.config.wsHeartbeatMs);
    }

    private stopHeartbeat() {
        if (!this.heartbeatTimer) {
            return;
        }

        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private sendInitialSubscription() {
        if (!this.ws || this.ws.readyState !== 1 || this.subscribedAssets.size === 0) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: 'market',
                assets_ids: [...this.subscribedAssets],
                custom_feature_enabled: true,
            })
        );
    }

    private sendIncrementalSubscription(assetIds: string[]) {
        if (!this.ws || this.ws.readyState !== 1 || assetIds.length === 0) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                assets_ids: assetIds,
                operation: 'subscribe',
                custom_feature_enabled: true,
            })
        );
    }

    private upsertSnapshot(assetId: string, partial: Partial<MarketBookSnapshot>) {
        const existing = this.snapshots.get(assetId);
        const nextSnapshot: MarketBookSnapshot = {
            assetId,
            market: partial.market || existing?.market,
            bids: partial.bids || existing?.bids || [],
            asks: partial.asks || existing?.asks || [],
            minOrderSize: partial.minOrderSize ?? existing?.minOrderSize ?? 0,
            tickSize: partial.tickSize || existing?.tickSize || '0.01',
            negRisk: partial.negRisk ?? existing?.negRisk ?? false,
            lastTradePrice: partial.lastTradePrice ?? existing?.lastTradePrice ?? 0,
            timestamp: partial.timestamp || Date.now(),
        };
        this.snapshots.set(assetId, nextSnapshot);
    }

    private updateBookSide(
        currentLevels: MarketBookLevel[],
        updates: Array<{ price?: string | number; size?: string | number }>,
        side: 'bids' | 'asks'
    ) {
        const levelMap = new Map<string, MarketBookLevel>();
        for (const level of currentLevels) {
            levelMap.set(level.price.toFixed(6), { ...level });
        }

        for (const update of updates) {
            const normalizedLevel = normalizeLevel(update);
            const key = normalizedLevel.price.toFixed(6);
            if (normalizedLevel.size <= 0) {
                levelMap.delete(key);
                continue;
            }

            levelMap.set(key, normalizedLevel);
        }

        return sortBookLevels([...levelMap.values()], side === 'bids' ? buySide : sellSide);
    }

    private handleMessage(rawData: string) {
        try {
            const normalizedData = String(rawData || '').trim();
            if (!normalizedData || normalizedData === 'PING' || normalizedData === 'PONG') {
                return;
            }
            if (!normalizedData.startsWith('{') && !normalizedData.startsWith('[')) {
                return;
            }

            const payload = JSON.parse(normalizedData) as MarketBookMessage | MarketBookMessage[];
            const messages = Array.isArray(payload) ? payload : [payload];
            for (const message of messages) {
                const assetId = String(message.asset_id || '').trim();
                if (!assetId) {
                    continue;
                }

                if (message.event_type === 'book') {
                    this.snapshots.set(
                        assetId,
                        buildMarketBookSnapshot(assetId, toBookSnapshotPayload(message))
                    );
                    continue;
                }

                if (message.event_type === 'price_change' && Array.isArray(message.changes)) {
                    const existing = this.snapshots.get(assetId);
                    if (!existing) {
                        continue;
                    }

                    const bidUpdates = message.changes.filter((change) => change.side === 'BUY');
                    const askUpdates = message.changes.filter((change) => change.side === 'SELL');
                    this.upsertSnapshot(assetId, {
                        market: message.market || existing.market,
                        bids: this.updateBookSide(existing.bids, bidUpdates, 'bids'),
                        asks: this.updateBookSide(existing.asks, askUpdates, 'asks'),
                        lastTradePrice: Number(message.last_trade_price) || existing.lastTradePrice,
                        timestamp: Number(message.timestamp) || Date.now(),
                    });
                    continue;
                }

                if (message.event_type === 'best_bid_ask') {
                    const existing = this.snapshots.get(assetId);
                    if (!existing) {
                        continue;
                    }

                    const bestBid = Number(message.best_bid);
                    const bestAsk = Number(message.best_ask);
                    this.upsertSnapshot(assetId, {
                        bids:
                            Number.isFinite(bestBid) && bestBid > 0
                                ? [
                                      { price: bestBid, size: existing.bids[0]?.size || 0 },
                                      ...existing.bids.slice(1),
                                  ]
                                : existing.bids,
                        asks:
                            Number.isFinite(bestAsk) && bestAsk > 0
                                ? [
                                      { price: bestAsk, size: existing.asks[0]?.size || 0 },
                                      ...existing.asks.slice(1),
                                  ]
                                : existing.asks,
                        timestamp: Date.now(),
                    });
                    continue;
                }

                if (message.event_type === 'tick_size_change') {
                    this.upsertSnapshot(assetId, {
                        tickSize: (message.tick_size || '0.01') as MarketBookSnapshot['tickSize'],
                        timestamp: Date.now(),
                    });
                }
            }
        } catch (error) {
            this.logger.error({ err: error }, '解析市场 websocket 消息失败');
        }
    }
}
