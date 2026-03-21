import { AssetType, ClobClient, createL2Headers } from '@polymarket/clob-client';
import type { ApiKeyCreds, ClobSigner, SignatureType } from '@polymarket/clob-client';
import getMyBalance from './getMyBalance';
import createLogger from './logger';

const logger = createLogger('guard');
const BALANCE_ALLOWANCE_PATH = '/balance-allowance';
const REQUEST_TIMEOUT_MS = 5000;

interface TradingGuardState {
    availableBalance: number | null;
    allowance: number | null;
    onChainBalance: number | null;
    clobBalance: number | null;
    openOrdersCount: number;
    skipReason: string;
}

interface BalanceAllowanceState {
    balance: number | null;
    allowance: number | null;
    source: 'sdk' | 'polymarket-api';
}

interface RuntimeClobClientShape {
    host?: string;
    signer?: ClobSigner;
    creds?: ApiKeyCreds;
    useServerTime?: boolean;
    getServerTime?: () => Promise<number>;
    orderBuilder?: {
        signatureType?: SignatureType;
    };
}

const toSafeNumber = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const buildBalanceAllowanceUrl = (host: string, signatureType: SignatureType) => {
    const url = new URL(`${host}${BALANCE_ALLOWANCE_PATH}`);
    url.searchParams.set('asset_type', AssetType.COLLATERAL);
    url.searchParams.set('signature_type', String(signatureType));
    return url.toString();
};

const fetchBalanceAllowanceViaPolymarketApi = async (
    clobClient: ClobClient
): Promise<BalanceAllowanceState | null> => {
    const runtimeClient = clobClient as unknown as RuntimeClobClientShape;
    if (
        !runtimeClient.host ||
        !runtimeClient.signer ||
        !runtimeClient.creds ||
        !runtimeClient.orderBuilder?.signatureType
    ) {
        logger.warn('缺少 Polymarket API 余额回退所需认证上下文');
        return null;
    }

    const timestamp =
        runtimeClient.useServerTime && typeof runtimeClient.getServerTime === 'function'
            ? await runtimeClient.getServerTime.call(clobClient)
            : undefined;
    const headers = await createL2Headers(
        runtimeClient.signer,
        runtimeClient.creds,
        {
            method: 'GET',
            requestPath: BALANCE_ALLOWANCE_PATH,
        },
        timestamp
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(
            buildBalanceAllowanceUrl(runtimeClient.host, runtimeClient.orderBuilder.signatureType),
            {
                method: 'GET',
                headers: headers as Record<string, string>,
                signal: controller.signal,
            }
        );
        const payload = (await response.json()) as {
            balance?: unknown;
            allowance?: unknown;
            error?: string;
        };

        if (!response.ok || payload.error) {
            logger.warn(
                `Polymarket API 余额回退失败 status=${response.status} reason=${payload.error || 'unknown'}`
            );
            return null;
        }

        return {
            balance: toSafeNumber(payload.balance),
            allowance: toSafeNumber(payload.allowance),
            source: 'polymarket-api',
        };
    } catch (error) {
        logger.warn('Polymarket API 余额回退请求失败', error);
        return null;
    } finally {
        clearTimeout(timeout);
    }
};

const loadBalanceAllowanceState = async (
    clobClient: ClobClient
): Promise<BalanceAllowanceState | null> => {
    try {
        try {
            await clobClient.updateBalanceAllowance({
                asset_type: AssetType.COLLATERAL,
            });
        } catch (error) {
            logger.warn('刷新代理钱包 balance allowance 失败，继续尝试读取现有余额快照', error);
        }

        const balanceAllowance = await clobClient.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
        });
        return {
            balance: toSafeNumber(balanceAllowance.balance),
            allowance: toSafeNumber(balanceAllowance.allowance),
            source: 'sdk',
        };
    } catch (error) {
        logger.warn(
            '通过 SDK 读取代理钱包 balance allowance 失败，准备回退到 Polymarket API',
            error
        );
        return fetchBalanceAllowanceViaPolymarketApi(clobClient);
    }
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

        const [onChainBalance, openOrders, balanceAllowanceState] = await Promise.all([
            getMyBalance(funderAddress),
            clobClient.getOpenOrders(undefined, true),
            loadBalanceAllowanceState(clobClient),
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

        const clobBalance = balanceAllowanceState?.balance ?? null;
        const allowance = balanceAllowanceState?.allowance ?? null;

        if (clobBalance === null || allowance === null) {
            return {
                availableBalance: null,
                allowance,
                onChainBalance,
                clobBalance,
                openOrdersCount: 0,
                skipReason: '',
            };
        }

        const availableBalance =
            onChainBalance === null
                ? Math.min(clobBalance, allowance)
                : Math.min(onChainBalance, clobBalance, allowance);

        if (balanceAllowanceState?.source === 'polymarket-api') {
            logger.warn(
                `已回退到 Polymarket API 读取代理钱包余额 available=${availableBalance.toFixed(4)}`
            );
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
            availableBalance,
            allowance,
            onChainBalance,
            clobBalance,
            openOrdersCount: 0,
            skipReason: '',
        };
    } catch (error) {
        logger.error('读取真实交易风控上下文失败', error);
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
