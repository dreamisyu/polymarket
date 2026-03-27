import { encodeFunctionData, zeroHash } from 'viem';
import type { Address, Hex } from 'viem';
import type { RuntimeConfig } from '../../config/runtimeConfig';
import { createWalletWriter, asAddress } from './wallet';

const positionTokenDecimals = 6;

const ctfMergeAbi = [
    {
        constant: false,
        inputs: [
            { name: 'collateralToken', type: 'address' },
            { name: 'parentCollectionId', type: 'bytes32' },
            { name: 'conditionId', type: 'bytes32' },
            { name: 'partition', type: 'uint256[]' },
            { name: 'amount', type: 'uint256' },
        ],
        name: 'mergePositions',
        outputs: [],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
    },
] as const;

const ctfRedeemAbi = [
    {
        constant: false,
        inputs: [
            { name: 'collateralToken', type: 'address' },
            { name: 'parentCollectionId', type: 'bytes32' },
            { name: 'conditionId', type: 'bytes32' },
            { name: 'indexSets', type: 'uint256[]' },
        ],
        name: 'redeemPositions',
        outputs: [],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
    },
] as const;

const isBytes32Hex = (value: string): value is Hex => /^0x[a-fA-F0-9]{64}$/.test(value);
const normalizeAmount = (value: number) =>
    BigInt(Math.max(Math.floor(Math.max(value, 0) * 10 ** positionTokenDecimals), 0));

export const submitConditionMerge = async (
    params: { conditionId: string; partition: bigint[]; amount: number },
    config: Pick<
        RuntimeConfig,
        'privateKey' | 'rpcUrl' | 'ctfContractAddress' | 'usdcContractAddress'
    >
) => {
    if (!isBytes32Hex(params.conditionId)) {
        throw new Error('conditionId 非法，无法提交 merge');
    }

    const wallet = createWalletWriter(config);
    return wallet.sendTransaction({
        account: wallet.account,
        chain: undefined,
        kzg: undefined,
        to: asAddress(config.ctfContractAddress),
        data: encodeFunctionData({
            abi: ctfMergeAbi,
            functionName: 'mergePositions',
            args: [
                asAddress(config.usdcContractAddress),
                zeroHash,
                params.conditionId,
                params.partition,
                normalizeAmount(params.amount),
            ],
        }),
    });
};

export const submitRedeemPositions = async (
    params: { conditionId: string; indexSets: bigint[] },
    config: Pick<
        RuntimeConfig,
        'privateKey' | 'rpcUrl' | 'ctfContractAddress' | 'usdcContractAddress'
    >
) => {
    if (!isBytes32Hex(params.conditionId)) {
        throw new Error('conditionId 非法，无法提交 redeem');
    }

    const wallet = createWalletWriter(config);
    return wallet.sendTransaction({
        account: wallet.account,
        chain: undefined,
        kzg: undefined,
        to: asAddress(config.ctfContractAddress),
        data: encodeFunctionData({
            abi: ctfRedeemAbi,
            functionName: 'redeemPositions',
            args: [
                asAddress(config.usdcContractAddress),
                zeroHash,
                params.conditionId,
                params.indexSets,
            ],
        }),
    });
};
