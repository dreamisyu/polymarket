import type { ApiKeyCreds } from '@polymarket/clob-client';
import type { AppConfig } from '@config/appConfig';
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

type ConfirmationStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

type UserTradeMessage = {
    event_type?: string;
    id?: string;
    market?: string;
    status?: string;
    taker_order_id?: string;
    maker_orders?: Array<{ order_id?: string }>;
    last_update?: string | number;
    timestamp?: string | number;
};

interface OrderLifecycleState {
    status: UserExecutionStatus;
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
    onStatus?: (update: UserExecutionStatusUpdate) => void | Promise<void>;
    resolve: (result: UserExecutionConfirmationResult) => void;
    lastStatusKey: string;
}

const millisecondTimestampThreshold = 1_000_000_000_000;

const getWebSocketConstructor = () =>
    (globalThis as unknown as { WebSocket?: RuntimeWebSocketConstructor }).WebSocket;

const normalizeTimestamp = (rawTimestamp: unknown, fallback: number) => {
    const parsedTimestamp = Number(rawTimestamp);
    if (!Number.isFinite(parsedTimestamp) || parsedTimestamp <= 0) {
        return fallback;
    }

    const normalizedTimestamp = Math.trunc(parsedTimestamp);
    return normalizedTimestamp < millisecondTimestampThreshold
        ? normalizedTimestamp * 1000
        : normalizedTimestamp;
};

const dedupeStrings = (values: string[]) =>
    [...new Set(values.map((value) => String(value || '').trim()))].filter(Boolean);

const normalizeStatus = (rawStatus: unknown): UserExecutionStatus | null => {
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

const buildAggregateStatus = (states: OrderLifecycleState[]) => {
    const failedStates = states.filter((state) => state.status === 'FAILED');
    if (failedStates.length > 0) {
        return {
            status: 'FAILED' as const,
            reason: `用户回报中有 ${failedStates.length} 笔订单失败`,
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
            reason: '用户回报显示链上交易重试中',
        };
    }

    if (states.some((state) => state.status === 'MINED')) {
        return {
            status: 'MINED' as const,
            reason: '用户回报显示链上已打包，等待最终确认',
        };
    }

    if (states.some((state) => state.status === 'MATCHED')) {
        return {
            status: 'MATCHED' as const,
            reason: '用户回报显示订单已撮合，等待链上打包',
        };
    }

    return {
        status: 'SUBMITTED' as const,
        reason: '等待用户 channel 首条执行回报',
    };
};

const safeInvoke = async (
    callback: (() => void | Promise<void>) | undefined,
    logger: LoggerLike
) => {
    if (!callback) {
        return;
    }

    try {
        await callback();
    } catch (error) {
        logger.error({ err: error }, '执行用户回报状态回调失败');
    }
};

export type UserExecutionStatus =
    | 'SUBMITTED'
    | 'MATCHED'
    | 'MINED'
    | 'RETRYING'
    | 'CONFIRMED'
    | 'FAILED';

export interface UserExecutionStatusUpdate {
    status: UserExecutionStatus;
    reason: string;
    matchedAt?: number;
    minedAt?: number;
    confirmedAt?: number;
}

export interface UserExecutionConfirmationResult extends UserExecutionStatusUpdate {
    confirmationStatus: ConfirmationStatus;
}

export interface UserExecutionFeed {
    isAvailable(): boolean;
    ensureMarket(conditionId: string): Promise<void>;
    waitForOrders(params: {
        conditionId: string;
        orderIds: string[];
        timeoutMs?: number;
        onStatus?: (update: UserExecutionStatusUpdate) => void | Promise<void>;
    }): Promise<UserExecutionConfirmationResult>;
}

export class PolymarketUserExecutionFeed implements UserExecutionFeed {
    private readonly url: string;
    private readonly reconnectMs: number;
    private readonly heartbeatMs: number;
    private readonly defaultTimeoutMs: number;
    private readonly logger: LoggerLike;
    private readonly creds: ApiKeyCreds;
    private readonly subscribedMarkets = new Set<string>();
    private readonly orderStates = new Map<string, OrderLifecycleState>();
    private readonly waiters = new Set<UserChannelWaiter>();
    private readonly waitersByOrderId = new Map<string, Set<UserChannelWaiter>>();
    private ws: RuntimeWebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private opening = false;

    constructor(params: {
        config: Pick<
            AppConfig,
            'userWsUrl' | 'userWsReconnectMs' | 'wsHeartbeatMs' | 'liveConfirmTimeoutMs'
        >;
        logger: LoggerLike;
        creds: ApiKeyCreds;
    }) {
        this.url = params.config.userWsUrl;
        this.reconnectMs = params.config.userWsReconnectMs;
        this.heartbeatMs = params.config.wsHeartbeatMs;
        this.defaultTimeoutMs = params.config.liveConfirmTimeoutMs;
        this.logger = params.logger;
        this.creds = params.creds;
    }

    isAvailable() {
        return Boolean(getWebSocketConstructor());
    }

    async ensureMarket(conditionId: string) {
        const normalizedConditionId = String(conditionId || '').trim();
        if (!normalizedConditionId) {
            return;
        }

        const alreadySubscribed = this.subscribedMarkets.has(normalizedConditionId);
        this.subscribedMarkets.add(normalizedConditionId);
        this.connect();
        if (!alreadySubscribed) {
            this.sendIncrementalSubscription([normalizedConditionId]);
        }
    }

    async waitForOrders(params: {
        conditionId: string;
        orderIds: string[];
        timeoutMs?: number;
        onStatus?: (update: UserExecutionStatusUpdate) => void | Promise<void>;
    }): Promise<UserExecutionConfirmationResult> {
        const orderIds = dedupeStrings(params.orderIds);
        if (orderIds.length === 0) {
            return {
                confirmationStatus: 'PENDING',
                status: 'SUBMITTED',
                reason: '缺少订单 ID，无法通过用户回报确认',
            };
        }

        if (!this.isAvailable()) {
            return {
                confirmationStatus: 'PENDING',
                status: 'SUBMITTED',
                reason: '当前运行环境不支持 websocket，回退链上确认',
            };
        }

        await this.ensureMarket(params.conditionId);

        return new Promise<UserExecutionConfirmationResult>((resolve) => {
            const waiter: UserChannelWaiter = {
                conditionId: String(params.conditionId || '').trim(),
                orderIds: new Set(orderIds),
                timeout: setTimeout(() => {
                    this.settleWaiter(waiter, {
                        confirmationStatus: 'PENDING',
                        status: this.buildWaiterResult(waiter).status,
                        reason: '等待用户回报超时，回退链上确认',
                        matchedAt: this.buildWaiterResult(waiter).matchedAt,
                        minedAt: this.buildWaiterResult(waiter).minedAt,
                        confirmedAt: this.buildWaiterResult(waiter).confirmedAt,
                    });
                }, params.timeoutMs || this.defaultTimeoutMs),
                settled: false,
                onStatus: params.onStatus,
                resolve,
                lastStatusKey: '',
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

    close() {
        this.subscribedMarkets.clear();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopHeartbeat();
        for (const waiter of [...this.waiters]) {
            this.settleWaiter(waiter, {
                confirmationStatus: 'PENDING',
                status: 'SUBMITTED',
                reason: '用户执行 websocket 已关闭',
            });
        }
        const currentWs = this.ws;
        this.ws = null;
        this.opening = false;
        if (currentWs) {
            currentWs.close();
        }
    }

    private connect() {
        const WebSocketConstructor = getWebSocketConstructor();
        if (!WebSocketConstructor || this.ws || this.opening) {
            return;
        }

        this.opening = true;
        const ws = new WebSocketConstructor(this.url);
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
            this.logger.error({ err: error }, '用户执行 websocket 异常');
        };
        ws.onclose = () => {
            this.ws = null;
            this.opening = false;
            this.stopHeartbeat();
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
        }, this.reconnectMs);
    }

    private startHeartbeat() {
        if (this.heartbeatTimer) {
            return;
        }

        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) {
                this.ws.send('PING');
            }
        }, this.heartbeatMs);
    }

    private stopHeartbeat() {
        if (!this.heartbeatTimer) {
            return;
        }

        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private sendInitialSubscription() {
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

    private sendIncrementalSubscription(markets: string[]) {
        if (!this.ws || this.ws.readyState !== 1 || markets.length === 0) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                markets,
                operation: 'subscribe',
            })
        );
    }

    private updateOrderState(
        orderId: string,
        status: UserExecutionStatus,
        message: UserTradeMessage
    ) {
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

    private emitStatus(waiter: UserChannelWaiter, update: UserExecutionStatusUpdate) {
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
        void safeInvoke(() => waiter.onStatus?.(update), this.logger);
    }

    private buildWaiterResult(waiter: UserChannelWaiter): UserExecutionConfirmationResult {
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

    private settleWaiter(waiter: UserChannelWaiter, result: UserExecutionConfirmationResult) {
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
            const normalizedData = String(rawData || '').trim();
            if (!normalizedData || normalizedData === 'PING' || normalizedData === 'PONG') {
                return;
            }
            if (!normalizedData.startsWith('{') && !normalizedData.startsWith('[')) {
                return;
            }

            const payload = JSON.parse(normalizedData) as UserTradeMessage | UserTradeMessage[];
            const messages = Array.isArray(payload) ? payload : [payload];
            for (const message of messages) {
                if (String(message.event_type || '').toLowerCase() !== 'trade') {
                    continue;
                }

                this.handleTradeMessage(message);
            }
        } catch (error) {
            this.logger.error({ err: error }, '解析用户执行 websocket 消息失败');
        }
    }
}
