import { AssetType, ClobClient } from '@polymarket/clob-client';
import getMyBalance from './getMyBalance';

interface TradingGuardState {
    availableBalance: number | null;
    allowance: number | null;
    onChainBalance: number | null;
    clobBalance: number | null;
    openOrdersCount: number;
    skipReason: string;
}

const toSafeNumber = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const getTradingGuardState = async (clobClient: ClobClient): Promise<TradingGuardState> => {
    try {
        const funderAddress = clobClient.orderBuilder.funderAddress;
        if (!funderAddress) {
            return {
                availableBalance: null,
                allowance: null,
                onChainBalance: null,
                clobBalance: null,
                openOrdersCount: 0,
                skipReason: '缺少 funderAddress，无法校验真实交易余额',
            };
        }

        const [onChainBalance, openOrders] = await Promise.all([
            getMyBalance(funderAddress),
            clobClient.getOpenOrders(undefined, true),
        ]);

        if (Array.isArray(openOrders) && openOrders.length > 0) {
            return {
                availableBalance: 0,
                allowance: null,
                onChainBalance,
                clobBalance: null,
                openOrdersCount: openOrders.length,
                skipReason: `检测到 ${openOrders.length} 笔未完成挂单，已暂停新的真实跟单`,
            };
        }

        await clobClient.updateBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
        });
        const balanceAllowance = await clobClient.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
        });
        const clobBalance = toSafeNumber(balanceAllowance.balance);
        const allowance = toSafeNumber(balanceAllowance.allowance);

        if (onChainBalance === null || clobBalance === null || allowance === null) {
            return {
                availableBalance: null,
                allowance,
                onChainBalance,
                clobBalance,
                openOrdersCount: 0,
                skipReason: '',
            };
        }

        if (allowance <= 0) {
            return {
                availableBalance: 0,
                allowance,
                onChainBalance,
                clobBalance,
                openOrdersCount: 0,
                skipReason: 'CLOB 授权额度为 0，已暂停新的真实跟单',
            };
        }

        return {
            availableBalance: Math.min(onChainBalance, clobBalance, allowance),
            allowance,
            onChainBalance,
            clobBalance,
            openOrdersCount: 0,
            skipReason: '',
        };
    } catch (error) {
        console.error('获取真实交易风控上下文失败:', error);
        return {
            availableBalance: null,
            allowance: null,
            onChainBalance: null,
            clobBalance: null,
            openOrdersCount: 0,
            skipReason: '',
        };
    }
};

export default getTradingGuardState;
