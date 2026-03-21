import {
    Address,
    Hex,
    createWalletClient,
    encodeFunctionData,
    http,
    parseUnits,
    zeroHash,
} from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ENV } from '../config/env';
import createLogger from './logger';
import { mergeReasons } from './runtime';

const logger = createLogger('merge');
const POSITION_TOKEN_DECIMALS = 6;

const CTF_MERGE_ABI = [
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

const normalizePrivateKey = (value: string): Hex =>
    (value.startsWith('0x') ? value : `0x${value}`) as Hex;

const isBytes32Hex = (value: string): value is Hex => /^0x[a-fA-F0-9]{64}$/.test(value);

let walletClient: ReturnType<
    typeof createWalletClient<typeof http, typeof polygon, ReturnType<typeof privateKeyToAccount>>
> | null = null;

const getWalletClient = () => {
    if (!walletClient) {
        walletClient = createWalletClient({
            account: privateKeyToAccount(normalizePrivateKey(ENV.PRIVATE_KEY)),
            chain: polygon,
            transport: http(ENV.RPC_URL),
        });
    }

    return walletClient;
};

export interface PostConditionMergeParams {
    conditionId: string;
    partition: bigint[];
    requestedSize: number;
    note?: string;
}

export interface PostConditionMergeResult {
    status: 'SUBMITTED' | 'SKIPPED' | 'RETRYABLE_ERROR' | 'FAILED';
    reason: string;
    transactionHashes: string[];
    submissionStatus?: 'SUBMITTED' | 'FAILED';
}

const buildResult = (
    status: PostConditionMergeResult['status'],
    reason: string,
    transactionHashes: string[] = [],
    submissionStatus?: 'SUBMITTED' | 'FAILED'
): PostConditionMergeResult => ({
    status,
    reason,
    transactionHashes: [
        ...new Set(transactionHashes.map((value) => String(value || '').trim())),
    ].filter(Boolean),
    submissionStatus,
});

const normalizeRequestedSize = (value: number) =>
    Math.max(
        Math.floor(Math.max(Number(value) || 0, 0) * 10 ** POSITION_TOKEN_DECIMALS) /
            10 ** POSITION_TOKEN_DECIMALS,
        0
    );

const postConditionMerge = async (
    params: PostConditionMergeParams
): Promise<PostConditionMergeResult> => {
    const normalizedConditionId = String(params.conditionId || '').trim();
    const normalizedPartition = [
        ...new Set(params.partition.filter((value) => value > 0n).map(String)),
    ]
        .map((value) => BigInt(value))
        .sort((left, right) => Number(left - right));
    const normalizedRequestedSize = normalizeRequestedSize(params.requestedSize);

    if (!isBytes32Hex(normalizedConditionId)) {
        return buildResult('SKIPPED', 'conditionId 非法，无法提交链上 merge');
    }

    if (normalizedPartition.length < 2) {
        return buildResult('SKIPPED', '缺少完整 outcome partition，无法执行链上 merge');
    }

    if (normalizedRequestedSize <= 0) {
        return buildResult('SKIPPED', 'merge 数量为 0，已跳过链上 merge');
    }

    try {
        const hash = await getWalletClient().sendTransaction({
            account: getWalletClient().account,
            to: ENV.POLYMARKET_CTF_CONTRACT_ADDRESS as Address,
            data: encodeFunctionData({
                abi: CTF_MERGE_ABI,
                functionName: 'mergePositions',
                args: [
                    ENV.USDC_CONTRACT_ADDRESS as Address,
                    zeroHash,
                    normalizedConditionId,
                    normalizedPartition,
                    parseUnits(
                        normalizedRequestedSize.toFixed(POSITION_TOKEN_DECIMALS),
                        POSITION_TOKEN_DECIMALS
                    ),
                ],
            }),
        });

        return buildResult('SUBMITTED', params.note || '', [hash], 'SUBMITTED');
    } catch (error) {
        logger.error(
            `提交链上 merge 失败 condition=${normalizedConditionId} size=${normalizedRequestedSize.toFixed(4)}`,
            error
        );
        return buildResult(
            'RETRYABLE_ERROR',
            mergeReasons(
                '链上 merge 提交失败',
                params.note,
                (error as { message?: string })?.message || ''
            )
        );
    }
};

export default postConditionMerge;
