import { Contract, JsonRpcProvider, formatUnits } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import { type Address, type Hex, createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import type { RuntimeConfig } from '@config/runtimeConfig';
import { withRpcTimeout } from '@infrastructure/chain/rpc';

const usdcAbi = ['function balanceOf(address owner) view returns (uint256)'];

const normalizePrivateKey = (value: string): Hex =>
    (value.startsWith('0x') ? value : `0x${value}`) as Hex;

export const createRpcProvider = (config: Pick<RuntimeConfig, 'rpcUrl'>) =>
    new JsonRpcProvider(config.rpcUrl);

export const getUsdcBalance = async (
    address: string,
    config: Pick<RuntimeConfig, 'rpcUrl' | 'usdcContractAddress'>
) => {
    const provider = createRpcProvider(config);
    const contract = new Contract(config.usdcContractAddress, usdcAbi, provider);
    const balance = await withRpcTimeout(
        contract.balanceOf(address),
        `读取 USDC 余额 address=${address}`
    );
    return Number.parseFloat(formatUnits(balance, 6));
};

export const createWalletWriter = (config: Pick<RuntimeConfig, 'privateKey' | 'rpcUrl'>) => {
    if (!config.privateKey) {
        throw new Error('缺少 PRIVATE_KEY');
    }

    return createWalletClient({
        account: privateKeyToAccount(normalizePrivateKey(config.privateKey)),
        chain: polygon,
        transport: http(config.rpcUrl),
    });
};

export const asAddress = (value: string) => value as Address;
export const asHex = (value: string) => value as Hex;
