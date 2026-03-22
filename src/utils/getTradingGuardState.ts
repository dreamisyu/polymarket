import { AssetType, ClobClient, createL2Headers } from '@polymarket/clob-client';
import type { ApiKeyCreds, ClobSigner, SignatureType } from '@polymarket/clob-client';
import getMyBalance from './getMyBalance';
import createLogger from './logger';

const logger = createLogger('guard');
const BALANCE_ALLOWANCE_PATH = '/balance-allowance';
const REQUEST_TIMEOUT_MS = 5000;
const GUARD_SUCCESS_CACHE_TTL_MS = 15000;
const USDC_DECIMALS = 6;
const USDC_BASE = 10n ** BigInt(USDC_DECIMALS);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

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

interface CachedTradingGuardState extends TradingGuardState {
    updatedAt: number;
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

let lastSuccessfulGuardState: CachedTradingGuardState | null = null;

const toSafeNumber = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const parseRawFixedPoint = (raw: bigint) => {
    const whole = raw / USDC_BASE;
    if (whole > MAX_SAFE_BIGINT) {
        return Number.MAX_SAFE_INTEGER;
    }

    return Number(whole) + Number(raw % USDC_BASE) / 10 ** USDC_DECIMALS;
};

const parseCollateralAmount = (value: unknown): number | null => {
    if (typeof value === 'bigint') {
        return parseRawFixedPoint(value);
    }

    if (typeof value === 'string') {
        const normalized = value.trim();
        if (/^\d+$/.test(normalized)) {
            return parseRawFixedPoint(BigInt(normalized));
        }

        return toSafeNumber(normalized);
    }

    return toSafeNumber(value);
};

const extractAllowanceAmount = (payload: {
    allowance?: unknown;
    allowances?: unknown;
}): number | null => {
    const directAllowance = parseCollateralAmount(payload.allowance);
    if (directAllowance !== null) {
        return directAllowance;
    }

    if (!payload.allowances || typeof payload.allowances !== 'object') {
        return null;
    }

    let maxAllowance: number | null = null;
    for (const rawValue of Object.values(payload.allowances as Record<string, unknown>)) {
        const allowance = parseCollateralAmount(rawValue);
        if (allowance === null) {
            continue;
        }

        maxAllowance = maxAllowance === null ? allowance : Math.max(maxAllowance, allowance);
    }

    return maxAllowance;
};

const extractClobError = (payload: unknown): string | null => {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const result = payload as Record<string, unknown>;
    if (!Object.hasOwn(result, 'error') || result.error === undefined || result.error === null) {
        return null;
    }

    const status = toSafeNumber(result.status);
    if (status !== null) {
        return `status=${status} reason=${String(result.error)}`;
    }

    return String(result.error);
};

const buildBalanceAllowanceUrl = (host: string, signatureType: SignatureType) => {
    const url = new URL(`${host}${BALANCE_ALLOWANCE_PATH}`);
    url.searchParams.set('asset_type', AssetType.COLLATERAL);
    url.searchParams.set('signature_type', String(signatureType));
    return url.toString();
};

const getRecentSuccessfulGuardState = () => {
    if (!lastSuccessfulGuardState) {
        return null;
    }

    const ageMs = Date.now() - lastSuccessfulGuardState.updatedAt;
    if (ageMs > GUARD_SUCCESS_CACHE_TTL_MS) {
        return null;
    }

    return {
        state: lastSuccessfulGuardState,
        ageMs,
    };
};

const rememberSuccessfulGuardState = (state: TradingGuardState) => {
    if (state.availableBalance === null || state.skipReason) {
        return;
    }

    lastSuccessfulGuardState = {
        ...state,
        updatedAt: Date.now(),
    };
};

const buildCachedGuardFallback = (
    reason: string,
    override: Partial<TradingGuardState> = {}
): TradingGuardState | null => {
    const cached = getRecentSuccessfulGuardState();
    if (!cached) {
        return null;
    }

    logger.warn(
        `${reason}，已回退到 ${cached.ageMs}ms 内的最近成功余额快照 available=${cached.state.availableBalance?.toFixed(4)}`
    );

    return {
        availableBalance: cached.state.availableBalance,
        allowance: cached.state.allowance,
        onChainBalance: cached.state.onChainBalance,
        clobBalance: cached.state.clobBalance,
        openOrdersCount: 0,
        skipReason: '',
        ...override,
    };
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
            allowances?: Record<string, unknown>;
            error?: string;
        };

        if (!response.ok || payload.error) {
            logger.warn(
                `Polymarket API 余额回退失败 status=${response.status} reason=${payload.error || 'unknown'}`
            );
            return null;
        }

        return {
            balance: parseCollateralAmount(payload.balance),
            allowance: extractAllowanceAmount(payload),
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
            const updateResult = (await clobClient.updateBalanceAllowance({
                asset_type: AssetType.COLLATERAL,
            })) as unknown;
            const updateError = extractClobError(updateResult);
            if (updateError) {
                logger.warn(
                    `刷新代理钱包 balance allowance 失败，继续尝试读取现有余额快照 reason=${updateError}`
                );
            }
        } catch (error) {
            logger.warn('刷新代理钱包 balance allowance 失败，继续尝试读取现有余额快照', error);
        }

        const balanceAllowance = (await clobClient.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
        })) as unknown;
        const sdkError = extractClobError(balanceAllowance);
        if (sdkError) {
            logger.warn(`通过 SDK 读取代理钱包 balance allowance 失败 reason=${sdkError}`);
            return fetchBalanceAllowanceViaPolymarketApi(clobClient);
        }

        const payload = balanceAllowance as {
            balance?: unknown;
            allowance?: unknown;
            allowances?: Record<string, unknown>;
        };
        return {
            balance: parseCollateralAmount(payload.balance),
            allowance: extractAllowanceAmount(payload),
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

        const [onChainBalance, openOrdersRaw, balanceAllowanceState] = await Promise.all([
            getMyBalance(funderAddress),
            (clobClient.getOpenOrders(undefined, true) as Promise<unknown>).catch((error) => ({
                error: (error as Error)?.message || String(error),
            })),
            loadBalanceAllowanceState(clobClient),
        ]);
        const openOrdersError = extractClobError(openOrdersRaw);
        if (openOrdersError) {
            logger.warn(`读取代理钱包未完成挂单失败 reason=${openOrdersError}`);
        }
        const openOrders = Array.isArray(openOrdersRaw) ? openOrdersRaw : [];

        if (openOrders.length > 0) {
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
        const recentSuccess = getRecentSuccessfulGuardState();
        const resolvedClobBalance = clobBalance ?? recentSuccess?.state.clobBalance ?? null;
        const resolvedAllowance = allowance ?? recentSuccess?.state.allowance ?? null;

        if (resolvedClobBalance === null || resolvedAllowance === null) {
            return (
                buildCachedGuardFallback('代理钱包 balance allowance 接口暂时不可用', {
                    onChainBalance: onChainBalance ?? recentSuccess?.state.onChainBalance ?? null,
                    clobBalance: resolvedClobBalance,
                    allowance: resolvedAllowance,
                }) || {
                    availableBalance: null,
                    allowance: resolvedAllowance,
                    onChainBalance,
                    clobBalance: resolvedClobBalance,
                    openOrdersCount: 0,
                    skipReason: '',
                }
            );
        }

        const availableBalance =
            onChainBalance === null
                ? Math.min(resolvedClobBalance, resolvedAllowance)
                : Math.min(onChainBalance, resolvedClobBalance, resolvedAllowance);

        if (balanceAllowanceState?.source === 'polymarket-api') {
            logger.warn(
                `已回退到 Polymarket API 读取代理钱包余额 available=${availableBalance.toFixed(4)}`
            );
        }

        if (resolvedAllowance <= 0) {
            return {
                availableBalance: 0,
                allowance: resolvedAllowance,
                onChainBalance,
                clobBalance: resolvedClobBalance,
                openOrdersCount: 0,
                skipReason: 'CLOB 授权额度为 0，已暂停新的真实跟单',
            };
        }

        const result = {
            availableBalance,
            allowance: resolvedAllowance,
            onChainBalance,
            clobBalance: resolvedClobBalance,
            openOrdersCount: 0,
            skipReason: '',
        };
        rememberSuccessfulGuardState(result);
        return result;
    } catch (error) {
        logger.error('读取真实交易风控上下文失败', error);
        return (
            buildCachedGuardFallback('读取真实交易风控上下文失败') || {
                availableBalance: null,
                allowance: null,
                onChainBalance: null,
                clobBalance: null,
                openOrdersCount: 0,
                skipReason: '',
            }
        );
    }
};

export default getTradingGuardState;
