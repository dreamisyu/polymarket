import { OrderBookSummary, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import {
    MarketBookLevel,
    MarketBookSnapshot,
    buildMarketBookSnapshot,
    sortBookLevels,
} from '../utils/executionPlanning';

const CLOB_WS_URL = ENV.CLOB_WS_URL;
const MARKET_CACHE_TTL_MS = ENV.MARKET_CACHE_TTL_MS;
const MARKET_WS_RECONNECT_MS = ENV.MARKET_WS_RECONNECT_MS;
const MARKET_WS_SNAPSHOT_WAIT_MS = ENV.MARKET_WS_SNAPSHOT_WAIT_MS;
const MARKET_WS_ENABLED = ENV.MARKET_WS_ENABLED;

type FetchBook = (assetId: string) => Promise<OrderBookSummary>;

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

const WebSocketConstructor = (
    globalThis as unknown as {
        WebSocket?: RuntimeWebSocketConstructor;
    }
).WebSocket;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeLevel = (level: {
    price?: string | number;
    size?: string | number;
}): MarketBookLevel => ({
    price: Math.max(Number(level.price) || 0, 0),
    size: Math.max(Number(level.size) || 0, 0),
});

export class ClobMarketStream {
    private readonly fetchBook: FetchBook;
    private readonly subscribedAssets = new Set<string>();
    private readonly snapshots = new Map<string, MarketBookSnapshot>();
    private ws: RuntimeWebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private opening = false;

    constructor(fetchBook: FetchBook) {
        this.fetchBook = fetchBook;
    }

    private connect() {
        if (!MARKET_WS_ENABLED || !WebSocketConstructor || this.ws || this.opening) {
            return;
        }

        this.opening = true;
        const ws = new WebSocketConstructor(CLOB_WS_URL);
        ws.onopen = () => {
            this.ws = ws;
            this.opening = false;
            this.sendSubscription();
            this.startHeartbeat();
        };
        ws.onmessage = (event) => {
            this.handleMessage(event.data);
        };
        ws.onerror = (error) => {
            console.error('市场 WebSocket 发生错误:', error);
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

    private startHeartbeat() {
        if (this.heartbeatTimer) {
            return;
        }

        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) {
                this.ws.send('PING');
            }
        }, 10_000);
    }

    private stopHeartbeat() {
        if (!this.heartbeatTimer) {
            return;
        }

        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private reconnect() {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, MARKET_WS_RECONNECT_MS);
    }

    private sendSubscription() {
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

    private upsertSnapshot(assetId: string, partial: Partial<MarketBookSnapshot>) {
        const existing = this.snapshots.get(assetId);
        const nextSnapshot: MarketBookSnapshot = {
            assetId,
            market: partial.market || existing?.market,
            bids: partial.bids || existing?.bids || [],
            asks: partial.asks || existing?.asks || [],
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

        return sortBookLevels([...levelMap.values()], side === 'bids' ? Side.BUY : Side.SELL);
    }

    private handleMessage(rawData: string) {
        try {
            const payload = JSON.parse(rawData) as
                | {
                      event_type?: string;
                      asset_id?: string;
                      market?: string;
                      bids?: Array<{ price: string; size: string }>;
                      asks?: Array<{ price: string; size: string }>;
                      tick_size?: string;
                      neg_risk?: boolean;
                      timestamp?: string;
                      last_trade_price?: string;
                      changes?: Array<{
                          side?: 'BUY' | 'SELL';
                          price?: string;
                          size?: string;
                      }>;
                      best_bid?: string;
                      best_ask?: string;
                  }
                | Array<{
                      asset_id?: string;
                      market?: string;
                      event_type?: string;
                      bids?: Array<{ price: string; size: string }>;
                      asks?: Array<{ price: string; size: string }>;
                      tick_size?: string;
                      neg_risk?: boolean;
                      timestamp?: string;
                      last_trade_price?: string;
                      changes?: Array<{
                          side?: 'BUY' | 'SELL';
                          price?: string;
                          size?: string;
                      }>;
                      best_bid?: string;
                      best_ask?: string;
                  }>;

            const messages = Array.isArray(payload) ? payload : [payload];
            for (const message of messages) {
                const assetId = String(message.asset_id || '').trim();
                if (!assetId) {
                    continue;
                }

                if (message.event_type === 'book') {
                    this.snapshots.set(assetId, buildMarketBookSnapshot(assetId, message));
                    continue;
                }

                if (message.event_type === 'price_change' && message.changes) {
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
            console.error('解析市场 WebSocket 消息失败:', error);
        }
    }

    async ensureAsset(assetId: string) {
        if (!assetId) {
            return;
        }

        this.subscribedAssets.add(assetId);
        this.connect();
        this.sendSubscription();
    }

    async getSnapshot(assetId: string): Promise<MarketBookSnapshot | null> {
        await this.ensureAsset(assetId);

        const currentSnapshot = this.snapshots.get(assetId);
        if (currentSnapshot && Date.now() - currentSnapshot.timestamp <= MARKET_CACHE_TTL_MS) {
            return currentSnapshot;
        }

        if (MARKET_WS_ENABLED && WebSocketConstructor) {
            await sleep(MARKET_WS_SNAPSHOT_WAIT_MS);
            const wsSnapshot = this.snapshots.get(assetId);
            if (wsSnapshot && Date.now() - wsSnapshot.timestamp <= MARKET_CACHE_TTL_MS) {
                return wsSnapshot;
            }
        }

        try {
            const orderBook = await this.fetchBook(assetId);
            const snapshot = buildMarketBookSnapshot(assetId, orderBook);
            this.snapshots.set(assetId, snapshot);
            return snapshot;
        } catch (error) {
            console.error(`获取 ${assetId} 市场快照失败:`, error);
            return this.snapshots.get(assetId) || null;
        }
    }
}

export default ClobMarketStream;
