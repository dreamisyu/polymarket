import { describe, expect, it } from '@jest/globals';
import { isMarketWindowClosed, resolveRepetitiveMarketWindow } from '../utils/marketWindow';

describe('marketWindow', () => {
    it('能从 repetitive updown eventSlug 解析开始与结束时间', () => {
        const window = resolveRepetitiveMarketWindow({
            eventSlug: 'eth-updown-5m-1774712700',
        });

        expect(window).toEqual({
            startTimeMs: 1774712700000,
            endTimeMs: 1774713000000,
            durationMs: 300000,
        });
    });

    it('市场结束后返回 closed=true', () => {
        expect(
            isMarketWindowClosed(
                {
                    eventSlug: 'btc-updown-15m-1774712700',
                },
                1774713600000
            )
        ).toBe(true);
    });

    it('非 repetitive market 不会误判为已结束', () => {
        expect(
            isMarketWindowClosed(
                {
                    eventSlug: 'some-other-market',
                },
                1774713600000
            )
        ).toBe(false);
    });
});
