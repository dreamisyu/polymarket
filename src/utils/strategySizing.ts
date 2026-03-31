import type { RuntimeConfig } from '@config/runtimeConfig';
import type { SourceTradeEvent, StrategySizingDecision } from '@domain';
import { getAggregatedTradeCount } from '@shared/copytradeDispatch';
import { computeBuyTargetUsdc, computeSellTargetSize } from '@shared/executionPlanning';
import { isTradeWithinSignalMarketScope } from '@shared/marketScope';

export const computeProportionalDecision = (
    event: SourceTradeEvent,
    availableBalance: number,
    localPositionSize: number,
    config: Pick<RuntimeConfig, 'maxOrderUsdc'>
): StrategySizingDecision => {
    if (event.action === 'buy') {
        const result = computeBuyTargetUsdc(event, availableBalance, config);
        if (result.status !== 'READY') {
            return {
                status: 'skip',
                reason: result.reason,
            };
        }

        return {
            status: 'ready',
            requestedUsdc: result.requestedUsdc,
            reason: result.reason,
            note: result.note,
        };
    }

    if (event.action === 'sell' || event.action === 'merge') {
        const result = computeSellTargetSize(
            event.action === 'merge' ? 'merge' : 'sell',
            localPositionSize,
            event as never,
            Math.max(Number(event.sourcePositionSizeAfterTrade) || 0, 0)
        );
        if (result.status !== 'READY') {
            return {
                status: 'skip',
                reason: result.reason,
            };
        }

        return {
            status: 'ready',
            requestedSize: result.requestedSize,
            reason: result.reason,
        };
    }

    return {
        status: 'skip',
        reason: '当前事件不在跟单策略范围内',
    };
};

export const computeFixedAmountDecision = (
    event: SourceTradeEvent,
    availableBalance: number,
    localPositionSize: number,
    config: Pick<RuntimeConfig, 'fixedTradeAmountUsdc'>
): StrategySizingDecision => {
    if (event.action === 'buy') {
        const requestedUsdc = Math.min(
            config.fixedTradeAmountUsdc * getAggregatedTradeCount(event),
            availableBalance
        );
        if (requestedUsdc <= 0) {
            return {
                status: 'skip',
                reason: '本地可用余额不足',
            };
        }

        return {
            status: 'ready',
            requestedUsdc,
            reason: '',
            note: `固定金额策略 ${requestedUsdc.toFixed(4)} USDC`,
        };
    }

    return computeProportionalDecision(event, availableBalance, localPositionSize, {
        maxOrderUsdc: 0,
    });
};

export const computeSignalDecision = (
    event: SourceTradeEvent,
    availableBalance: number,
    localPositionSize: number,
    config: Pick<
        RuntimeConfig,
        | 'signalMarketScope'
        | 'signalWeakThresholdUsdc'
        | 'signalNormalThresholdUsdc'
        | 'signalStrongThresholdUsdc'
        | 'signalWeakTicketUsdc'
        | 'signalNormalTicketUsdc'
        | 'signalStrongTicketUsdc'
        | 'maxOrderUsdc'
    >
): StrategySizingDecision => {
    if (event.action !== 'buy') {
        return computeProportionalDecision(event, availableBalance, localPositionSize, config);
    }

    if (config.signalMarketScope === 'crypto_updown_5m' && !isTradeWithinSignalMarketScope(event)) {
        return {
            status: 'skip',
            reason: '当前信号策略仅跟加密货币 5 分钟 Up/Down 市场',
        };
    }

    const buildSignalDecision = (
        requestedUsdc: number,
        note: string,
        ticketTier: NonNullable<StrategySizingDecision['ticketTier']>
    ): StrategySizingDecision =>
        requestedUsdc <= 0
            ? {
                  status: 'skip',
                  reason: '本地可用余额不足',
              }
            : {
                  status: 'ready',
                  requestedUsdc,
                  reason: '',
                  note,
                  ticketTier,
              };

    const sourceUsdc = Math.max(Number(event.usdcSize) || 0, 0);
    if (sourceUsdc >= config.signalStrongThresholdUsdc) {
        return buildSignalDecision(
            Math.min(config.signalStrongTicketUsdc, availableBalance),
            '强信号票据',
            'strong'
        );
    }

    if (sourceUsdc >= config.signalNormalThresholdUsdc) {
        return buildSignalDecision(
            Math.min(config.signalNormalTicketUsdc, availableBalance),
            '普通信号票据',
            'normal'
        );
    }

    if (sourceUsdc >= config.signalWeakThresholdUsdc) {
        return buildSignalDecision(
            Math.min(config.signalWeakTicketUsdc, availableBalance),
            '弱信号票据',
            'weak'
        );
    }

    return {
        status: 'skip',
        reason: '未达到信号策略的最小触发阈值',
    };
};
