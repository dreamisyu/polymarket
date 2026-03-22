import { BuilderApiKeyCreds, BuilderConfig } from '@polymarket/builder-signing-sdk';
import { RelayClient, RelayerTxType, TransactionType } from '@polymarket/builder-relayer-client';
import type { ClobClient } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { ENV } from '../config/env';
import createLogger from './logger';

const logger = createLogger('relayer');
const RELAYER_CHAIN_ID = 137;

export type EffectiveRelayerMode = 'SAFE' | 'PROXY';
export type BuilderConfigSource = 'env' | 'clob' | 'none';

interface EffectiveRelayerRuntime {
    mode: EffectiveRelayerMode;
    safeAddress: string;
    safeDeployed: boolean | null;
    proxyRelayAvailable: boolean;
}

interface BuilderConfigRuntime {
    builderConfig?: BuilderConfig;
    source: BuilderConfigSource;
}

let relayerRuntimePromise: Promise<EffectiveRelayerRuntime> | null = null;
let builderConfigRuntimePromise: Promise<BuilderConfigRuntime> | null = null;

const normalizePrivateKey = (value: string) => (value.startsWith('0x') ? value : `0x${value}`);

const isValidBuilderCreds = (
    value: BuilderApiKeyCreds | null | undefined
): value is BuilderApiKeyCreds =>
    Boolean(value?.key?.trim() && value?.secret?.trim() && value?.passphrase?.trim());

const createRelayWalletClient = () =>
    createWalletClient({
        account: privateKeyToAccount(normalizePrivateKey(ENV.PRIVATE_KEY) as `0x${string}`),
        chain: polygon,
        transport: http(ENV.RPC_URL),
    });

const toRelayerTxType = (mode: EffectiveRelayerMode) =>
    mode === 'PROXY' ? RelayerTxType.PROXY : RelayerTxType.SAFE;

const hasProxyRelayPayload = (payload: unknown): payload is { address: string; nonce: string } => {
    if (!payload || typeof payload !== 'object') {
        return false;
    }

    const candidate = payload as Record<string, unknown>;
    return typeof candidate.address === 'string' && candidate.address.length > 0;
};

const resolveEffectiveRelayerRuntime = async (): Promise<EffectiveRelayerRuntime> => {
    try {
        const walletClient = createRelayWalletClient();
        const safeRelayClient = new RelayClient(
            ENV.POLYMARKET_RELAYER_URL,
            RELAYER_CHAIN_ID,
            walletClient,
            undefined,
            RelayerTxType.SAFE
        );
        const proxyRelayClient = new RelayClient(
            ENV.POLYMARKET_RELAYER_URL,
            RELAYER_CHAIN_ID,
            walletClient,
            undefined,
            RelayerTxType.PROXY
        );
        const signerAddress = await walletClient.account.address;
        const safeAddress = await safeRelayClient.getExpectedSafe();
        const [safeDeployedResult, proxyPayloadResult] = await Promise.all([
            safeRelayClient.getDeployed(safeAddress).catch(() => null),
            proxyRelayClient
                .getRelayPayload(signerAddress, TransactionType.PROXY)
                .catch(() => null),
        ]);

        const safeDeployed = typeof safeDeployedResult === 'boolean' ? safeDeployedResult : null;
        const proxyRelayAvailable = hasProxyRelayPayload(proxyPayloadResult);
        let mode: EffectiveRelayerMode = ENV.POLYMARKET_RELAYER_TX_TYPE;

        if (mode === 'SAFE' && safeDeployed === false && proxyRelayAvailable) {
            logger.warn(
                `检测到 SAFE 未部署且 PROXY relay 可用，已自动切换为 PROXY wallet=${ENV.PROXY_WALLET}`
            );
            mode = 'PROXY';
        } else if (mode === 'PROXY' && !proxyRelayAvailable && safeDeployed === true) {
            logger.warn(
                `检测到 PROXY relay 不可用但 SAFE 已部署，已自动切换为 SAFE wallet=${safeAddress}`
            );
            mode = 'SAFE';
        }

        return {
            mode,
            safeAddress,
            safeDeployed,
            proxyRelayAvailable,
        };
    } catch (error) {
        logger.warn(
            `探测 relayer 钱包类型失败，继续沿用配置 txType=${ENV.POLYMARKET_RELAYER_TX_TYPE}`,
            error
        );
        return {
            mode: ENV.POLYMARKET_RELAYER_TX_TYPE,
            safeAddress: '',
            safeDeployed: null,
            proxyRelayAvailable: false,
        };
    }
};

export const getEffectiveRelayerRuntime = async () => {
    if (!relayerRuntimePromise) {
        relayerRuntimePromise = resolveEffectiveRelayerRuntime();
    }

    return relayerRuntimePromise;
};

export const getEffectiveRelayerMode = async () => {
    const runtime = await getEffectiveRelayerRuntime();
    return runtime.mode;
};

export const getLiveBuilderConfigRuntime = async (
    createAuthedClobClient?: () => Promise<ClobClient>
) => {
    if (!builderConfigRuntimePromise) {
        builderConfigRuntimePromise = (async () => {
            const envCreds: BuilderApiKeyCreds = {
                key: ENV.POLY_BUILDER_API_KEY,
                secret: ENV.POLY_BUILDER_SECRET,
                passphrase: ENV.POLY_BUILDER_PASSPHRASE,
            };

            if (isValidBuilderCreds(envCreds)) {
                return {
                    builderConfig: new BuilderConfig({
                        localBuilderCreds: envCreds,
                    }),
                    source: 'env' as const,
                };
            }

            if (!createAuthedClobClient) {
                return { source: 'none' as const };
            }

            try {
                const clobClient = await createAuthedClobClient();
                const builderCreds = (await clobClient.createBuilderApiKey()) as BuilderApiKeyCreds;
                if (!isValidBuilderCreds(builderCreds)) {
                    return { source: 'none' as const };
                }

                logger.warn('未显式配置 builder 凭据，已通过 CLOB 自动创建临时 builder key');
                return {
                    builderConfig: new BuilderConfig({
                        localBuilderCreds: builderCreds,
                    }),
                    source: 'clob' as const,
                };
            } catch (error) {
                logger.warn('自动创建 builder key 失败，将继续尝试无 builder 鉴权', error);
                return { source: 'none' as const };
            }
        })();
    }

    return builderConfigRuntimePromise;
};

export { toRelayerTxType };
