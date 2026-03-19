import { Side, TickSize } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { UserActivityInterface } from '../interfaces/User';

const MAX_SLIPPAGE_BPS = ENV.MAX_SLIPPAGE_BPS;
const MAX_ORDER_USDC = ENV.MAX_ORDER_USDC;
const BUY_DUST_RESIDUAL_MODE = ENV.BUY_DUST_RESIDUAL_MODE;
const MIN_MARKET_BUY_USDC = 1;
const MIN_LIMIT_ORDER_SIZE = 5;

export interface MarketBookLevel {
    price: number;
    size: number;
}

export interface MarketBookSnapshot {
    assetId: string;
    market?: string;
    bids: MarketBookLevel[];
    asks: MarketBookLevel[];
    minOrderSize: number;
    tickSize: TickSize;
    negRisk: boolean;
    lastTradePrice: number;
    timestamp: number;
}

export interface ChunkExecutionPlan {
    status: 'READY' | 'SKIPPED' | 'RETRYABLE_ERROR';
    reason: string;
    requestedSize: number;
    requestedUsdc: number;
    orderAmount: number;
    executionPrice: number;
    side?: Side;
    tickSize?: TickSize;
    negRisk?: boolean;
    note?: string;
    allowPartialCompletion?: boolean;
}

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const sortBookLevels = (levels: MarketBookLevel[], side: Side) =>
    [...levels]
        .filter((level) => level.price > 0 && level.size > 0)
        .sort((left, right) =>
            side === Side.BUY
                ? right.price - left.price || right.size - left.size
                : left.price - right.price
        );

export const normalizeBookLevel = (level: { price?: string | number; size?: string | number }) => ({
    price: Math.max(toSafeNumber(level.price), 0),
    size: Math.max(toSafeNumber(level.size), 0),
});

export const cloneMarketSnapshot = (snapshot: MarketBookSnapshot): MarketBookSnapshot => ({
    ...snapshot,
    bids: snapshot.bids.map((level) => ({ ...level })),
    asks: snapshot.asks.map((level) => ({ ...level })),
});

export const consumeMarketLiquidity = (
    snapshot: MarketBookSnapshot,
    side: Side,
    amount: number,
    price: number
) => {
    const levels = side === Side.BUY ? snapshot.asks : snapshot.bids;
    if (levels.length === 0 || amount <= 0 || price <= 0) {
        return;
    }

    const priceTolerance = 1e-8;
    let remainingAmount = amount;

    for (const level of levels) {
        const isPriceMatch =
            side === Side.BUY
                ? level.price <= price + priceTolerance
                : level.price >= price - priceTolerance;
        if (!isPriceMatch || remainingAmount <= 0) {
            break;
        }

        if (side === Side.BUY) {
            const levelUsdc = level.price * level.size;
            const consumedUsdc = Math.min(levelUsdc, remainingAmount);
            const consumedSize = consumedUsdc / level.price;
            level.size = Math.max(level.size - consumedSize, 0);
            remainingAmount -= consumedUsdc;
            continue;
        }

        const consumedSize = Math.min(level.size, remainingAmount);
        level.size = Math.max(level.size - consumedSize, 0);
        remainingAmount -= consumedSize;
    }

    const filteredLevels = sortBookLevels(levels, side === Side.BUY ? Side.SELL : Side.BUY);
    if (side === Side.BUY) {
        snapshot.asks = filteredLevels;
    } else {
        snapshot.bids = filteredLevels;
    }
};

export const buildMarketBookSnapshot = (
    assetId: string,
    orderBook: {
        market?: string;
        asset_id?: string;
        timestamp?: string | number;
        bids?: Array<{ price: string; size: string }>;
        asks?: Array<{ price: string; size: string }>;
        min_order_size?: string;
        tick_size?: string;
        neg_risk?: boolean;
        last_trade_price?: string;
    }
): MarketBookSnapshot => ({
    assetId,
    market: orderBook.market,
    bids: sortBookLevels((orderBook.bids || []).map(normalizeBookLevel), Side.BUY),
    asks: sortBookLevels((orderBook.asks || []).map(normalizeBookLevel), Side.SELL),
    minOrderSize: Math.max(toSafeNumber(orderBook.min_order_size), 0),
    tickSize: (orderBook.tick_size || '0.01') as TickSize,
    negRisk: Boolean(orderBook.neg_risk),
    lastTradePrice: Math.max(toSafeNumber(orderBook.last_trade_price), 0),
    timestamp: toSafeNumber(orderBook.timestamp, Date.now()),
});

const isAcceptableBuyPrice = (askPrice: number, sourcePrice: number) =>
    askPrice <= sourcePrice * (1 + MAX_SLIPPAGE_BPS / 10_000);

const isAcceptableSellPrice = (bidPrice: number, sourcePrice: number) =>
    bidPrice >= sourcePrice * (1 - MAX_SLIPPAGE_BPS / 10_000);

const getEffectiveMinOrderSize = (marketSnapshot: MarketBookSnapshot) =>
    Math.max(toSafeNumber(marketSnapshot.minOrderSize), MIN_LIMIT_ORDER_SIZE);

const collectBuyLiquidity = (
    asks: MarketBookLevel[],
    sourcePrice: number,
    requestedUsdc: number
) => {
    let availableUsdc = 0;
    let executionPrice = 0;

    for (const ask of asks) {
        if (!isAcceptableBuyPrice(ask.price, sourcePrice)) {
            break;
        }

        const levelUsdc = ask.price * ask.size;
        const chunkUsdc = Math.min(requestedUsdc - availableUsdc, levelUsdc);
        if (chunkUsdc <= 0) {
            continue;
        }

        availableUsdc += chunkUsdc;
        executionPrice = ask.price;

        if (availableUsdc >= requestedUsdc) {
            break;
        }
    }

    return {
        availableUsdc,
        executionPrice,
    };
};

const collectSellLiquidity = (
    bids: MarketBookLevel[],
    sourcePrice: number,
    requestedSize: number
) => {
    let availableSize = 0;
    let executionPrice = 0;

    for (const bid of bids) {
        if (!isAcceptableSellPrice(bid.price, sourcePrice)) {
            break;
        }

        const chunkSize = Math.min(requestedSize - availableSize, bid.size);
        if (chunkSize <= 0) {
            continue;
        }

        availableSize += chunkSize;
        executionPrice = bid.price;

        if (availableSize >= requestedSize) {
            break;
        }
    }

    return {
        availableSize,
        executionPrice,
    };
};

export const computeBuyTargetUsdc = (
    trade: UserActivityInterface,
    availableBalance: number,
    sourceBalanceAfterTrade: number
) => {
    const denominator = sourceBalanceAfterTrade + Math.max(toSafeNumber(trade.usdcSize), 0);
    if (denominator <= 0) {
        return {
            status: 'SKIPPED' as const,
            reason: '源账户余额快照无效，无法计算跟单比例',
            requestedUsdc: 0,
            note: '',
        };
    }

    if (availableBalance <= 0) {
        return {
            status: 'SKIPPED' as const,
            reason: '本地可用余额不足',
            requestedUsdc: 0,
            note: '',
        };
    }

    const ratio = availableBalance / denominator;
    let requestedUsdc = Math.min(
        Math.max(toSafeNumber(trade.usdcSize), 0) * ratio,
        availableBalance
    );
    let note = '';

    if (MAX_ORDER_USDC > 0 && requestedUsdc > MAX_ORDER_USDC) {
        requestedUsdc = MAX_ORDER_USDC;
        note = `已按单笔风控上限裁剪至 ${MAX_ORDER_USDC.toFixed(4)} USDC`;
    }

    if (requestedUsdc <= 0) {
        return {
            status: 'SKIPPED' as const,
            reason: '裁剪后可用下单金额为 0',
            requestedUsdc: 0,
            note,
        };
    }

    return {
        status: 'READY' as const,
        reason: '',
        requestedUsdc,
        note,
    };
};

export const computeSellTargetSize = (
    condition: string,
    myPositionSize: number,
    trade: UserActivityInterface,
    sourcePositionAfterTradeSize: number
) => {
    if (myPositionSize <= 0) {
        return {
            status: 'SKIPPED' as const,
            reason: condition === 'merge' ? '本地无可 merge 的持仓' : '本地没有可卖出的仓位',
            requestedSize: 0,
        };
    }

    if (condition === 'merge') {
        return {
            status: 'READY' as const,
            reason: '',
            requestedSize: myPositionSize,
        };
    }

    const denominator = sourcePositionAfterTradeSize + Math.max(toSafeNumber(trade.size), 0);
    const requestedSize =
        denominator > 0
            ? myPositionSize * (Math.max(toSafeNumber(trade.size), 0) / denominator)
            : 0;

    if (requestedSize <= 0) {
        return {
            status: 'SKIPPED' as const,
            reason: '没有可卖出的数量',
            requestedSize: 0,
        };
    }

    return {
        status: 'READY' as const,
        reason: '',
        requestedSize: Math.min(requestedSize, myPositionSize),
    };
};

export const buildChunkExecutionPlan = (params: {
    condition: string;
    trade: UserActivityInterface;
    myPositionSize: number;
    sourcePositionAfterTradeSize: number;
    availableBalance: number;
    sourceBalanceAfterTrade: number;
    marketSnapshot: MarketBookSnapshot;
    remainingRequestedUsdc?: number;
    remainingRequestedSize?: number;
    requestedUsdcOverride?: number;
    requestedSizeOverride?: number;
    sourcePriceOverride?: number;
    noteOverride?: string;
}): ChunkExecutionPlan => {
    const {
        condition,
        trade,
        myPositionSize,
        sourcePositionAfterTradeSize,
        availableBalance,
        sourceBalanceAfterTrade,
        marketSnapshot,
        remainingRequestedUsdc,
        remainingRequestedSize,
        requestedUsdcOverride,
        requestedSizeOverride,
        sourcePriceOverride,
        noteOverride,
    } = params;
    const sourcePrice = Math.max(toSafeNumber(sourcePriceOverride, trade.price), 0);

    if (sourcePrice <= 0) {
        return {
            status: 'SKIPPED',
            reason: '源成交价无效，已暂停执行',
            requestedSize: 0,
            requestedUsdc: 0,
            orderAmount: 0,
            executionPrice: 0,
        };
    }

    if (condition === 'buy') {
        const buyTarget =
            requestedUsdcOverride !== undefined
                ? {
                      status:
                          Math.min(Math.max(requestedUsdcOverride, 0), availableBalance) > 0
                              ? ('READY' as const)
                              : ('SKIPPED' as const),
                      reason:
                          Math.min(Math.max(requestedUsdcOverride, 0), availableBalance) > 0
                              ? ''
                              : '裁剪后可用下单金额为 0',
                      requestedUsdc: Math.min(Math.max(requestedUsdcOverride, 0), availableBalance),
                      note:
                          requestedUsdcOverride > availableBalance
                              ? [noteOverride, '已按当前可用余额裁剪批次买单金额']
                                    .filter(Boolean)
                                    .join('；')
                              : noteOverride || '',
                  }
                : computeBuyTargetUsdc(trade, availableBalance, sourceBalanceAfterTrade);
        if (buyTarget.status !== 'READY') {
            return {
                status: buyTarget.status,
                reason: buyTarget.reason,
                requestedSize: 0,
                requestedUsdc: 0,
                orderAmount: 0,
                executionPrice: 0,
                note: buyTarget.note,
            };
        }

        const topAsk = marketSnapshot.asks[0];
        if (!topAsk) {
            return {
                status: 'RETRYABLE_ERROR',
                reason: '盘口暂无卖单',
                requestedSize: buyTarget.requestedUsdc / sourcePrice,
                requestedUsdc: buyTarget.requestedUsdc,
                orderAmount: 0,
                executionPrice: 0,
                note: buyTarget.note,
            };
        }

        if (!isAcceptableBuyPrice(topAsk.price, sourcePrice)) {
            return {
                status: 'SKIPPED',
                reason: `当前买价超出允许滑点（${MAX_SLIPPAGE_BPS}bps）`,
                requestedSize: buyTarget.requestedUsdc / sourcePrice,
                requestedUsdc: buyTarget.requestedUsdc,
                orderAmount: 0,
                executionPrice: topAsk.price,
                note: buyTarget.note,
            };
        }

        const nextRequestedUsdc = remainingRequestedUsdc ?? buyTarget.requestedUsdc;
        if (nextRequestedUsdc < MIN_MARKET_BUY_USDC) {
            return {
                status: 'SKIPPED',
                reason: `剩余买单金额低于平台最小下单金额 ${MIN_MARKET_BUY_USDC} USDC`,
                requestedSize: buyTarget.requestedUsdc / topAsk.price,
                requestedUsdc: buyTarget.requestedUsdc,
                orderAmount: 0,
                executionPrice: topAsk.price,
                note: buyTarget.note,
                allowPartialCompletion: remainingRequestedUsdc !== undefined,
            };
        }

        const buyLiquidity = collectBuyLiquidity(
            marketSnapshot.asks,
            sourcePrice,
            nextRequestedUsdc
        );
        if (buyLiquidity.availableUsdc < MIN_MARKET_BUY_USDC) {
            return {
                status: 'RETRYABLE_ERROR',
                reason: `盘口可成交金额不足 ${MIN_MARKET_BUY_USDC} USDC`,
                requestedSize: buyTarget.requestedUsdc / topAsk.price,
                requestedUsdc: buyTarget.requestedUsdc,
                orderAmount: 0,
                executionPrice: buyLiquidity.executionPrice || topAsk.price,
                note: buyTarget.note,
                allowPartialCompletion: remainingRequestedUsdc !== undefined,
            };
        }

        const residualBuyUsdc = Math.max(nextRequestedUsdc - buyLiquidity.availableUsdc, 0);
        if (
            BUY_DUST_RESIDUAL_MODE !== 'off' &&
            residualBuyUsdc > 0 &&
            residualBuyUsdc < MIN_MARKET_BUY_USDC
        ) {
            if (BUY_DUST_RESIDUAL_MODE === 'trim') {
                const trimmedOrderAmount = Math.max(nextRequestedUsdc - MIN_MARKET_BUY_USDC, 0);
                if (
                    trimmedOrderAmount >= MIN_MARKET_BUY_USDC &&
                    buyLiquidity.availableUsdc + 1e-8 >= trimmedOrderAmount
                ) {
                    return {
                        status: 'READY',
                        reason: '',
                        requestedSize: buyTarget.requestedUsdc / buyLiquidity.executionPrice,
                        requestedUsdc: buyTarget.requestedUsdc,
                        orderAmount: trimmedOrderAmount,
                        executionPrice: buyLiquidity.executionPrice,
                        side: Side.BUY,
                        tickSize: marketSnapshot.tickSize,
                        negRisk: marketSnapshot.negRisk,
                        note: [buyTarget.note, '已裁剪本次买单，避免产生小于 1 USDC 的尾单']
                            .filter(Boolean)
                            .join('；'),
                    };
                }
            }

            return {
                status: 'RETRYABLE_ERROR',
                reason: `当前可成交金额会留下小于 ${MIN_MARKET_BUY_USDC} USDC 的尾单，已暂缓执行`,
                requestedSize: buyTarget.requestedUsdc / buyLiquidity.executionPrice,
                requestedUsdc: buyTarget.requestedUsdc,
                orderAmount: 0,
                executionPrice: buyLiquidity.executionPrice,
                note: buyTarget.note,
                allowPartialCompletion: remainingRequestedUsdc !== undefined,
            };
        }

        return {
            status: 'READY',
            reason: '',
            requestedSize: buyTarget.requestedUsdc / buyLiquidity.executionPrice,
            requestedUsdc: buyTarget.requestedUsdc,
            orderAmount: buyLiquidity.availableUsdc,
            executionPrice: buyLiquidity.executionPrice,
            side: Side.BUY,
            tickSize: marketSnapshot.tickSize,
            negRisk: marketSnapshot.negRisk,
            note: buyTarget.note,
        };
    }

    if (condition === 'sell' || condition === 'merge') {
        const sellTarget =
            requestedSizeOverride !== undefined
                ? {
                      status:
                          requestedSizeOverride > 0 ? ('READY' as const) : ('SKIPPED' as const),
                      reason: requestedSizeOverride > 0 ? '' : '没有可卖出的数量',
                      requestedSize: Math.max(requestedSizeOverride, 0),
                  }
                : computeSellTargetSize(
                      condition,
                      myPositionSize,
                      trade,
                      sourcePositionAfterTradeSize
                  );
        if (sellTarget.status !== 'READY') {
            return {
                status: sellTarget.status,
                reason: sellTarget.reason,
                requestedSize: sellTarget.requestedSize,
                requestedUsdc: 0,
                orderAmount: 0,
                executionPrice: 0,
            };
        }

        const topBid = marketSnapshot.bids[0];
        if (!topBid) {
            return {
                status: 'RETRYABLE_ERROR',
                reason: '盘口暂无买单',
                requestedSize: sellTarget.requestedSize,
                requestedUsdc: sellTarget.requestedSize * sourcePrice,
                orderAmount: 0,
                executionPrice: 0,
            };
        }

        if (!isAcceptableSellPrice(topBid.price, sourcePrice)) {
            return {
                status: 'SKIPPED',
                reason: `当前卖一价格超出允许滑点（${MAX_SLIPPAGE_BPS}bps）`,
                requestedSize: sellTarget.requestedSize,
                requestedUsdc: sellTarget.requestedSize * topBid.price,
                orderAmount: 0,
                executionPrice: topBid.price,
            };
        }

        const nextRequestedSize = remainingRequestedSize ?? sellTarget.requestedSize;
        const minOrderSize = getEffectiveMinOrderSize(marketSnapshot);
        if (nextRequestedSize < minOrderSize) {
            return {
                status: 'SKIPPED',
                reason: `剩余卖单数量低于平台最小下单数量 ${minOrderSize.toFixed(4)}`,
                requestedSize: sellTarget.requestedSize,
                requestedUsdc: sellTarget.requestedSize * topBid.price,
                orderAmount: 0,
                executionPrice: topBid.price,
                allowPartialCompletion: remainingRequestedSize !== undefined,
            };
        }

        const sellLiquidity = collectSellLiquidity(
            marketSnapshot.bids,
            sourcePrice,
            nextRequestedSize
        );
        if (sellLiquidity.availableSize < minOrderSize) {
            return {
                status: 'RETRYABLE_ERROR',
                reason: `盘口可成交数量不足 ${minOrderSize.toFixed(4)}`,
                requestedSize: sellTarget.requestedSize,
                requestedUsdc:
                    sellTarget.requestedSize * (sellLiquidity.executionPrice || topBid.price),
                orderAmount: 0,
                executionPrice: sellLiquidity.executionPrice || topBid.price,
                allowPartialCompletion: remainingRequestedSize !== undefined,
            };
        }

        return {
            status: 'READY',
            reason: '',
            requestedSize: sellTarget.requestedSize,
            requestedUsdc: sellTarget.requestedSize * sellLiquidity.executionPrice,
            orderAmount: sellLiquidity.availableSize,
            executionPrice: sellLiquidity.executionPrice,
            side: Side.SELL,
            tickSize: marketSnapshot.tickSize,
            negRisk: marketSnapshot.negRisk,
        };
    }

    return {
        status: 'SKIPPED',
        reason: `暂不支持的执行条件: ${condition}`,
        requestedSize: Math.max(toSafeNumber(trade.size), 0),
        requestedUsdc: Math.max(toSafeNumber(trade.usdcSize), 0),
        orderAmount: 0,
        executionPrice: sourcePrice,
    };
};
