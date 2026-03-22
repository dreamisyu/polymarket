import createClobClient from '../src/utils/createClobClient';
import getTradingGuardState from '../src/utils/getTradingGuardState';
import { ENV } from '../src/config/env';
import { AssetType } from '@polymarket/clob-client';
import { RelayClient, RelayerTxType, TransactionType } from '@polymarket/builder-relayer-client';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, erc20Abi, http } from 'viem';
import { polygon } from 'viem/chains';
import { getEffectiveRelayerMode } from '../src/utils/liveRelayerRuntime';

const main = async () => {
    const clobClient = await createClobClient();
    const guard = await getTradingGuardState(clobClient);
    const effectiveRelayerMode = await getEffectiveRelayerMode();
    const rawBalanceAllowance = await clobClient.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
    } as never);

    const normalizedPrivateKey = ENV.PRIVATE_KEY.startsWith('0x')
        ? ENV.PRIVATE_KEY
        : `0x${ENV.PRIVATE_KEY}`;
    const account = privateKeyToAccount(normalizedPrivateKey as `0x${string}`);
    const walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http(ENV.RPC_URL),
    });
    const publicClient = createPublicClient({
        chain: polygon,
        transport: http(ENV.RPC_URL),
    });

    const safeRelayClient = new RelayClient(
        ENV.POLYMARKET_RELAYER_URL,
        137,
        walletClient,
        undefined,
        RelayerTxType.SAFE
    );
    const proxyRelayClient = new RelayClient(
        ENV.POLYMARKET_RELAYER_URL,
        137,
        walletClient,
        undefined,
        RelayerTxType.PROXY
    );
    const expectedSafeAddress = await safeRelayClient.getExpectedSafe();
    const [safeDeployed, proxyRelayPayload, usdcAllowanceToCtf] = await Promise.all([
        safeRelayClient.getDeployed(expectedSafeAddress).catch((error) => ({
            error: String((error as Error)?.message || error),
        })),
        proxyRelayClient.getRelayPayload(account.address, TransactionType.PROXY).catch((error) => ({
            error: String((error as Error)?.message || error),
        })),
        publicClient
            .readContract({
                address: ENV.USDC_CONTRACT_ADDRESS as `0x${string}`,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [
                    ENV.PROXY_WALLET as `0x${string}`,
                    ENV.POLYMARKET_CTF_CONTRACT_ADDRESS as `0x${string}`,
                ],
            })
            .catch((error) => ({
                error: String((error as Error)?.message || error),
            })),
    ]);

    const output = {
        executionMode: ENV.EXECUTION_MODE,
        relayerTxType: ENV.POLYMARKET_RELAYER_TX_TYPE,
        effectiveRelayerMode,
        relayerUrl: ENV.POLYMARKET_RELAYER_URL,
        builderAuthConfigured: Boolean(
            ENV.POLY_BUILDER_API_KEY && ENV.POLY_BUILDER_SECRET && ENV.POLY_BUILDER_PASSPHRASE
        ),
        guard,
        rawBalanceAllowance,
        expectedSafeAddress,
        safeDeployed,
        proxyRelayPayload,
        usdcAllowanceToCtf:
            typeof usdcAllowanceToCtf === 'bigint'
                ? usdcAllowanceToCtf.toString()
                : usdcAllowanceToCtf,
    };

    console.log(JSON.stringify(output, null, 2));
};

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
