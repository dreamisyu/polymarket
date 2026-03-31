import { describe, expect, it, jest } from '@jest/globals';
import { fetchSourceActivities } from '@infrastructure/polymarket/api';

jest.mock('../infrastructure/http/fetchJson', () => ({
    __esModule: true,
    fetchJson: jest.fn(),
}));

const { fetchJson } = jest.requireMock('../infrastructure/http/fetchJson') as {
    fetchJson: jest.MockedFunction<
        <T>(
            url: string,
            init?: RequestInit,
            retries?: number,
            delayMs?: number
        ) => Promise<T | null>
    >;
};

describe('fetchSourceActivities', () => {
    it('活动接口请求会显式按 TIMESTAMP 升序排序', async () => {
        fetchJson.mockResolvedValueOnce([]);

        await fetchSourceActivities(
            {
                start: 1774708982,
                end: 1774708983,
                limit: 100,
            },
            '0xd9013df863c1ba932780857b020dfdeacedf8e14',
            {
                dataApiUrl: 'https://data-api.polymarket.com',
            }
        );

        expect(fetchJson).toHaveBeenCalledWith(
            'https://data-api.polymarket.com/activity?user=0xd9013df863c1ba932780857b020dfdeacedf8e14&start=1774708982&end=1774708983&limit=100&sortBy=TIMESTAMP&sortDirection=ASC'
        );
    });
});
