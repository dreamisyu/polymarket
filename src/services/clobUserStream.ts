import { ApiKeyCreds } from '@polymarket/clob-client';
import { ENV } from '../config/env';

const USER_WS_URL = ENV.USER_WS_URL;
const USER_WS_RECONNECT_MS = ENV.USER_WS_RECONNECT_MS;
const ORDER_CONFIRMATION_TIMEOUT_MS = ENV.ORDER_CONFIRMATION_TIMEOUT_MS;
const MILLISECOND_TIMESTAMP_THRESHOLD = 1_000_000_000_000;

type ConfirmationStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';
export type UserTradeStatus =
    | 'SUBMITTED'
    | 'MATCHED'
    | 'MINED'
    | 'RETRYING'
    | 'CONFIRMED'
    | 'FAILED';

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

interface UserTradeMessage {
    event_type?: string;
    id?: string;
    market?: string;
    status?: string;
    taker_order_id?: string;
    maker_orders?: Array<{
        order_id?: string;
    }>;
    last_update?: string | number;
    timestamp?: string | number;
}

interface OrderLifecycleState {
    status: UserTradeStatus;
    updatedAt: number;
    matchedAt?: number;
    minedAt?: number;
    confirmedAt?: number;
    tradeIds: string[];
}

interface UserChannelWaiter {
    conditionId: string;
    orderIds: Set<string>;
    timeout: ReturnType<typeof setTimeout>;
    settled: boolean;
    onStatus?: (update: UserChannelStatusUpdate) => void | Promise<void>;
    resolve: (result: UserChannelConfirmationResult) => void;
    lastStatusKey: string;
}

export interface UserChannelStatusUpdate {
    status: UserTradeStatus;
    reason: string;
    matchedAt?: number;
    minedAt?: number;
    confirmedAt?: number;
}

export interface UserChannelConfirmationResult extends UserChannelStatusUpdate {
    confirmationStatus: ConfirmationStatus;
}

const WebSocketConstructor = (
    globalThis as unknown as {
        WebSocket?: RuntimeWebSocketConstructor;
    }
).WebSocket;

const normalizeTimestamp = (rawTimestamp: unknown, fallback: number) => {
    const parsedTimestamp = Number(rawTimestamp);
    if (!Number.isFinite(parsedTimestamp) || parsedTimestamp <= 0) {
        return fallback;
    }

    const normalizedTimestamp = Math.trunc(parsedTimestamp);
    return normalizedTimestamp < MILLISECOND_TIMESTAMP_THRESHOLD
        ? normalizedTimestamp * 1000
        : normalizedTimestamp;
};

const normalizeStatus = (rawStatus: unknown): UserTradeStatus | null => {
    const status = String(rawStatus || '')
        .trim()
        .toUpperCase();

    if (status === 'MATCHED' || status === 'MINED' || status === 'RETRYING') {
        return status;
    }

    if (status === 'CONFIRMED' || status === 'FAILED') {
        return status;
    }

    return null;
};

const buildOrderIdsFromMessage = (message: UserTradeMessage) => {
    const orderIds = new Set<string>();
    const takerOrderId = String(message.taker_order_id || '').trim();
    if (takerOrderId) {
        orderIds.add(takerOrderId);
    }

    for (const makerOrder of message.maker_orders || []) {
        const makerOrderId = String(makerOrder.order_id || '').trim();
        if (makerOrderId) {
            orderIds.add(makerOrderId);
        }
    }

    return [...orderIds];
};

const dedupeStrings = (values: string[]) =>
    [...new Set(values.map((value) => String(value || '').trim()))].filter(Boolean);

const buildAggregateStatus = (states: OrderLifecycleState[]) => {
    const failedStates = states.filter((state) => state.status === 'FAILED');
    if (failedStates.length > 0) {
        return {
            status: 'FAILED' as const,
            reason: `User Channel 回报 ${failedStates.length} 笔订单失败`,
        };
    }

    if (states.length > 0 && states.every((state) => state.status === 'CONFIRMED')) {
        return {
            status: 'CONFIRMED' as const,
            reason: '',
        };
    }

    if (states.some((state) => state.status === 'RETRYING')) {
        return {
            status: 'RETRYING' as const,
            reason: 'User Channel 回报链上交易重试中',
        };
    }

    if (states.some((state) => state.status === 'MINED')) {
        return {
            status: 'MINED' as const,
            reason: 'User Channel 回报链上已打包，等待最终确认',
        };
    }

    if (states.some((state) => state.status === 'MATCHED')) {
        return {
            status: 'MATCHED' as const,
            reason: 'User Channel 回报撮合完成，等待链上打包',
        };
    }

    return {
        status: 'SUBMITTED' as const,
        reason: '等待 User Channel 首条成交回报',
    };
};

const safeInvoke = async (callback: (() => void | Promise<void>) | undefined) => {
    if (!callback) {
        return;
    }

    try {
        await callback();
    } catch (error) {
        console.error('执行 User Channel 状态回调失败:', error);
    }
};

export class ClobUserStream {
    private readonly creds: ApiKeyCreds;
    private readonly subscribedMarkets = new Set<string>();
    private readonly orderStates = new Map<string, OrderLifecycleState>();
    private readonly waiters = new Set<UserChannelWaiter>();
    private readonly waitersByOrderId = new Map<string, Set<UserChannelWaiter>>();
    private ws: RuntimeWebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private opening = false;

    constructor(creds: ApiKeyCreds) {
        this.creds = creds;
    }

    isAvailable() {
        return Boolean(WebSocketConstructor);
    }

    private connect() {
        if (!WebSocketConstructor || this.ws || this.opening) {
            return;
        }

        this.opening = true;
        const ws = new WebSocketConstructor(USER_WS_URL);
        ws.onopen = () => {
            this.ws = ws;
            this.opening = false;
            this.sendSubscription();
        };
        ws.onmessage = (event) => {
            this.handleMessage(event.data);
        };
        ws.onerror = (error) => {
            console.error('User Channel WebSocket 发生错误:', error);
        };
        ws.onclose = () => {
            this.ws = null;
            this.opening = false;
            if (this.subscribedMarkets.size > 0 || this.waiters.size > 0) {
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
        }, USER_WS_RECONNECT_MS);
    }

    private sendSubscription() {
        if (!this.ws || this.ws.readyState !== 1 || this.subscribedMarkets.size === 0) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                auth: {
                    apiKey: this.creds.key,
                    secret: this.creds.secret,
                    passphrase: this.creds.passphrase,
                },
                markets: [...this.subscribedMarkets],
                type: 'user',
            })
        );
    }

    async ensureMarket(conditionId: string) {
        const normalizedConditionId = String(conditionId || '').trim();
        if (!normalizedConditionId) {
            return;
        }

        this.subscribedMarkets.add(normalizedConditionId);
        this.connect();
        this.sendSubscription();
    }

    private updateOrderState(orderId: string, status: UserTradeStatus, message: UserTradeMessage) {
        const updatedAt = normalizeTimestamp(message.last_update || message.timestamp, Date.now());
        const existingState = this.orderStates.get(orderId);
        const nextState: OrderLifecycleState = {
            status,
            updatedAt,
            matchedAt: existingState?.matchedAt,
            minedAt: existingState?.minedAt,
            confirmedAt: existingState?.confirmedAt,
            tradeIds: dedupeStrings([...(existingState?.tradeIds || []), String(message.id || '')]),
        };

        if (status === 'MATCHED') {
            nextState.matchedAt = existingState?.matchedAt || updatedAt;
        }

        if (status === 'MINED') {
            nextState.matchedAt = existingState?.matchedAt || updatedAt;
            nextState.minedAt = existingState?.minedAt || updatedAt;
        }

        if (status === 'CONFIRMED') {
            nextState.matchedAt = existingState?.matchedAt || updatedAt;
            nextState.minedAt = existingState?.minedAt || updatedAt;
            nextState.confirmedAt = existingState?.confirmedAt || updatedAt;
        }

        this.orderStates.set(orderId, nextState);
        return nextState;
    }

    private emitStatus(waiter: UserChannelWaiter, update: UserChannelStatusUpdate) {
        if (update.status === 'SUBMITTED') {
            return;
        }

        const statusKey = [
            update.status,
            update.reason,
            update.matchedAt || 0,
            update.minedAt || 0,
            update.confirmedAt || 0,
        ].join(':');

        if (statusKey === waiter.lastStatusKey) {
            return;
        }

        waiter.lastStatusKey = statusKey;
        void safeInvoke(() => waiter.onStatus?.(update));
    }

    private buildWaiterResult(waiter: UserChannelWaiter): UserChannelConfirmationResult {
        const states = [...waiter.orderIds]
            .map((orderId) => this.orderStates.get(orderId))
            .filter((state): state is OrderLifecycleState => Boolean(state));
        const missingOrderCount = waiter.orderIds.size - states.length;
        const aggregate = buildAggregateStatus(states);
        const matchedAt = states
            .map((state) => state.matchedAt)
            .filter((timestamp): timestamp is number => Boolean(timestamp))
            .sort((left, right) => left - right)[0];
        const minedAt = states
            .map((state) => state.minedAt)
            .filter((timestamp): timestamp is number => Boolean(timestamp))
            .sort((left, right) => left - right)[0];
        const confirmedAt = states
            .map((state) => state.confirmedAt)
            .filter((timestamp): timestamp is number => Boolean(timestamp))
            .sort((left, right) => right - left)[0];

        if (missingOrderCount === 0 && aggregate.status === 'CONFIRMED') {
            return {
                confirmationStatus: 'CONFIRMED',
                status: 'CONFIRMED',
                reason: '',
                matchedAt,
                minedAt,
                confirmedAt,
            };
        }

        if (aggregate.status === 'FAILED') {
            return {
                confirmationStatus: 'FAILED',
                status: 'FAILED',
                reason: aggregate.reason,
                matchedAt,
                minedAt,
                confirmedAt,
            };
        }

        return {
            confirmationStatus: 'PENDING',
            status: aggregate.status,
            reason: aggregate.reason,
            matchedAt,
            minedAt,
            confirmedAt,
        };
    }

    private cleanupWaiter(waiter: UserChannelWaiter) {
        clearTimeout(waiter.timeout);
        this.waiters.delete(waiter);
        for (const orderId of waiter.orderIds) {
            const orderWaiters = this.waitersByOrderId.get(orderId);
            if (!orderWaiters) {
                continue;
            }

            orderWaiters.delete(waiter);
            if (orderWaiters.size === 0) {
                this.waitersByOrderId.delete(orderId);
            }
        }
    }

    private settleWaiter(waiter: UserChannelWaiter, result: UserChannelConfirmationResult) {
        if (waiter.settled) {
            return;
        }

        waiter.settled = true;
        this.cleanupWaiter(waiter);
        waiter.resolve(result);
    }

    private evaluateWaiter(waiter: UserChannelWaiter) {
        if (waiter.settled) {
            return;
        }

        const result = this.buildWaiterResult(waiter);
        this.emitStatus(waiter, result);

        if (result.confirmationStatus !== 'PENDING') {
            this.settleWaiter(waiter, result);
        }
    }

    private handleTradeMessage(message: UserTradeMessage) {
        const status = normalizeStatus(message.status);
        if (!status) {
            return;
        }

        const orderIds = buildOrderIdsFromMessage(message);
        if (orderIds.length === 0) {
            return;
        }

        const impactedWaiters = new Set<UserChannelWaiter>();
        for (const orderId of orderIds) {
            this.updateOrderState(orderId, status, message);

            const orderWaiters = this.waitersByOrderId.get(orderId);
            if (!orderWaiters) {
                continue;
            }

            for (const waiter of orderWaiters) {
                impactedWaiters.add(waiter);
            }
        }

        for (const waiter of impactedWaiters) {
            this.evaluateWaiter(waiter);
        }
    }

    private handleMessage(rawData: string) {
        try {
            const payload = JSON.parse(rawData) as UserTradeMessage | UserTradeMessage[];
            const messages = Array.isArray(payload) ? payload : [payload];

            for (const message of messages) {
                if (String(message.event_type || '').toLowerCase() !== 'trade') {
                    continue;
                }

                this.handleTradeMessage(message);
            }
        } catch (error) {
            console.error('解析 User Channel 消息失败:', error);
        }
    }

    async waitForOrders(params: {
        conditionId: string;
        orderIds: string[];
        timeoutMs?: number;
        onStatus?: (update: UserChannelStatusUpdate) => void | Promise<void>;
    }): Promise<UserChannelConfirmationResult> {
        const orderIds = dedupeStrings(params.orderIds);
        if (orderIds.length === 0) {
            return {
                confirmationStatus: 'PENDING',
                status: 'SUBMITTED',
                reason: '缺少订单 ID，无法通过 User Channel 确认',
            };
        }

        if (!WebSocketConstructor) {
            return {
                confirmationStatus: 'PENDING',
                status: 'SUBMITTED',
                reason: '当前运行时不支持 WebSocket，无法连接 User Channel',
            };
        }

        await this.ensureMarket(params.conditionId);

        return new Promise<UserChannelConfirmationResult>((resolve) => {
            const waiter: UserChannelWaiter = {
                conditionId: params.conditionId,
                orderIds: new Set(orderIds),
                settled: false,
                onStatus: params.onStatus,
                resolve,
                lastStatusKey: '',
                timeout: setTimeout(() => {
                    const result = this.buildWaiterResult(waiter);
                    this.settleWaiter(waiter, {
                        ...result,
                        confirmationStatus: 'PENDING',
                        reason: [
                            result.reason,
                            `等待 User Channel 确认超时（${params.timeoutMs || ORDER_CONFIRMATION_TIMEOUT_MS}ms）`,
                        ]
                            .filter(Boolean)
                            .join('；'),
                    });
                }, params.timeoutMs || ORDER_CONFIRMATION_TIMEOUT_MS),
            };

            this.waiters.add(waiter);
            for (const orderId of waiter.orderIds) {
                const orderWaiters =
                    this.waitersByOrderId.get(orderId) || new Set<UserChannelWaiter>();
                orderWaiters.add(waiter);
                this.waitersByOrderId.set(orderId, orderWaiters);
            }

            this.evaluateWaiter(waiter);
        });
    }
}

export default ClobUserStream;
