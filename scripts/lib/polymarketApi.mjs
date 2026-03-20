import axios from 'axios';

export const fetchPolymarketPositions = async (walletAddress, userAgent) => {
    if (!String(walletAddress || '').trim()) {
        return {
            walletAddress: '',
            positions: null,
            error: '未提供钱包地址',
        };
    }

    try {
        const response = await axios.get(
            `https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=0`,
            {
                timeout: 10000,
                headers: {
                    'User-Agent': userAgent || 'polymarket-copytrading-bot/script',
                },
            }
        );

        return {
            walletAddress,
            positions: Array.isArray(response.data) ? response.data : [],
            error: '',
        };
    } catch (error) {
        return {
            walletAddress,
            positions: null,
            error: error?.response?.data?.error || error?.message || '获取 Polymarket 持仓失败',
        };
    }
};
