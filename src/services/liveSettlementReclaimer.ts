import {
    RelayClient,
    RelayerTransaction,
    RelayerTransactionState,
    RelayerTxType,
    Transaction,
} from '@polymarket/builder-relayer-client';
import type { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { CopyExecutionBatchInterface, CopyIntentBufferInterface } from '../interfaces/Execution';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getCopyExecutionBatchModel, getCopyIntentBufferModel } from '../models/copyExecution';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import createLogger from '../utils/logger';
import {
    buildPolymarketMarketSlugFromTitle,
    fetchPolymarketMarketResolution,
    isResolvedPolymarketMarket,
} from '../utils/polymarketMarketResolution';
import createClobClient from '../utils/createClobClient';
import {
    getEffectiveRelayerMode,
    getLiveBuilderConfigRuntime,
    toRelayerTxType,
} from '../utils/liveRelayerRuntime';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { Address, Hex, createWalletClient, encodeFunctionData, http, zeroHash } from 'viem';

const logger = createLogger('settlement');
const RELAYER_CHAIN_ID = 137;
const PROXY_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}&sizeThreshold=0`;
const AUTH_ERROR_BACKOFF_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 1000;
const UserActivity = getUserActivityModel(ENV.USER_ADDRESS);
const CopyIntentBuffer = getCopyIntentBufferModel(ENV.USER_ADDRESS);
const CopyExecutionBatch = getCopyExecutionBatchModel(ENV.USER_ADDRESS);

const CTF_REDEEM_ABI = [
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

interface RedeemBatch {
    conditionId: Hex;
    indexSets: bigint[];
    positionCount: number;
    estimatedPayout: number;
}

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const formatAmount = (value: unknown) => toSafeNumber(value).toFixed(4);

const normalizePrivateKey = (value: string): Hex =>
    (value.startsWith('0x') ? value : `0x${value}`) as Hex;

const isBytes32Hex = (value: string): value is Hex => /^0x[a-fA-F0-9]{64}$/.test(value);

const extractErrorMessage = (error: unknown) =>
    String(
        (error as { response?: { data?: { error?: string; message?: string } } })?.response?.data
            ?.error ||
            (error as { response?: { data?: { message?: string } } })?.response?.data?.message ||
            (error as { message?: string })?.message ||
            error ||
            '未知错误'
    );

const isAuthError = (message: string) => /401|403|unauthorized|forbidden|builder/i.test(message);

const groupRedeemablePositions = (positions: UserPositionInterface[]): RedeemBatch[] => {
    const grouped = new Map<
        string,
        {
            conditionId: Hex;
            indexSets: Set<string>;
            positionCount: number;
            estimatedPayout: number;
        }
    >();

    for (const position of positions) {
        if (!position.redeemable) {
            continue;
        }

        const conditionId = String(position.conditionId || '').trim();
        const positionSize = Math.max(toSafeNumber(position.size), 0);
        const outcomeIndex = Number(position.outcomeIndex);
        if (!isBytes32Hex(conditionId) || positionSize <= 0) {
            continue;
        }

        if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex > 255) {
            continue;
        }

        const existing = grouped.get(conditionId) || {
            conditionId,
            indexSets: new Set<string>(),
            positionCount: 0,
            estimatedPayout: 0,
        };
        existing.indexSets.add((1n << BigInt(outcomeIndex)).toString());
        existing.positionCount += 1;
        existing.estimatedPayout += positionSize;
        grouped.set(conditionId, existing);
    }

    return [...grouped.values()]
        .map((group) => ({
            conditionId: group.conditionId,
            indexSets: [...group.indexSets].map((value) => BigInt(value)),
            positionCount: group.positionCount,
            estimatedPayout: group.estimatedPayout,
        }))
        .filter((group) => group.indexSets.length > 0)
        .sort(
            (left, right) =>
                right.estimatedPayout - left.estimatedPayout ||
                right.positionCount - left.positionCount
        );
};

const buildRedeemTransaction = (batch: RedeemBatch): Transaction => ({
    to: ENV.POLYMARKET_CTF_CONTRACT_ADDRESS,
    data: encodeFunctionData({
        abi: CTF_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: [ENV.USDC_CONTRACT_ADDRESS as Address, zeroHash, batch.conditionId, batch.indexSets],
    }),
    value: '0',
});

const mergeReasons = (...reasons: string[]) =>
    [...new Set(reasons.map((reason) => String(reason || '').trim()).filter(Boolean))].join('；');

const buildResolvedSkipReason = (winnerOutcome: string) =>
    `市场已 resolved winner=${winnerOutcome || 'unknown'}，已停止继续跟单并等待自动回收`;

const resolveMarketSlug = (subject: {
    marketSlug?: string;
    eventSlug?: string;
    slug?: string;
    title?: string;
}) =>
    String(subject.marketSlug || subject.eventSlug || subject.slug || '').trim() ||
    buildPolymarketMarketSlugFromTitle(String(subject.title || '').trim());

class LiveSettlementReclaimer {
    private readonly autoRedeemEnabled = ENV.AUTO_REDEEM_ENABLED;
    private readonly intervalMs = ENV.AUTO_REDEEM_INTERVAL_MS;
    private readonly maxConditionsPerRun = ENV.AUTO_REDEEM_MAX_CONDITIONS_PER_RUN;
    private readonly walletClient = this.autoRedeemEnabled
        ? createWalletClient({
              account: privateKeyToAccount(normalizePrivateKey(ENV.PRIVATE_KEY)),
              chain: polygon,
              transport: http(ENV.RPC_URL),
          })
        : null;
    private relayTxType: RelayerTxType = toRelayerTxType(ENV.POLYMARKET_RELAYER_TX_TYPE);
    private relayClient: RelayClient | null;
    private relayReadyPromise: Promise<void> | null = null;
    private usingBuilderAuth = false;
    private redeemAuthUnavailable = false;
    private running = false;
    private nextRunAt = 0;
    private inflightTransactionId = '';
    private inflightTransactionHash = '';
    private inflightConditionCount = 0;

    constructor() {
        this.relayClient = null;
    }

    private async ensureRelayClient() {
        if (!this.autoRedeemEnabled || !this.walletClient) {
            return;
        }

        if (!this.relayReadyPromise) {
            this.relayReadyPromise = (async () => {
                const effectiveMode = await getEffectiveRelayerMode();
                const builderRuntime = await getLiveBuilderConfigRuntime(() => createClobClient());
                this.relayTxType = toRelayerTxType(effectiveMode);
                this.usingBuilderAuth = Boolean(builderRuntime.builderConfig);
                this.relayClient = this.createRelayClient(builderRuntime.builderConfig);
                logger.info(
                    `自动回收鉴权已就绪 txType=${effectiveMode} builder=${builderRuntime.source}`
                );
            })().catch((error) => {
                this.relayClient = this.createRelayClient();
                this.usingBuilderAuth = false;
                logger.warn('初始化自动回收 relayer 鉴权失败，已回退到无鉴权路径', error);
            });
        }

        await this.relayReadyPromise;
    }

    private createRelayClient(builderConfig?: BuilderConfig) {
        if (!this.walletClient) {
            return null;
        }

        return new RelayClient(
            ENV.POLYMARKET_RELAYER_URL,
            RELAYER_CHAIN_ID,
            this.walletClient,
            builderConfig,
            this.relayTxType
        );
    }

    private disableBuilderAuthFallback() {
        if (!this.usingBuilderAuth) {
            return false;
        }

        this.usingBuilderAuth = false;
        this.relayClient = this.createRelayClient();
        logger.warn('builder 鉴权被 relayer 拒绝，自动回收已回退到无鉴权路径');
        return true;
    }

    private scheduleNextRun(delayMs = this.intervalMs) {
        this.nextRunAt = Date.now() + delayMs;
    }

    private clearInflightTransaction() {
        this.inflightTransactionId = '';
        this.inflightTransactionHash = '';
        this.inflightConditionCount = 0;
    }

    private async syncInflightTransaction() {
        if (!this.relayClient || !this.inflightTransactionId) {
            return;
        }

        let transaction: RelayerTransaction | undefined;
        try {
            const transactions = await this.relayClient.getTransaction(this.inflightTransactionId);
            transaction = transactions[0];
        } catch (error) {
            logger.error('查询自动回收状态失败', error);
            this.scheduleNextRun();
            return;
        }

        if (!transaction) {
            this.scheduleNextRun();
            return;
        }

        if (
            transaction.state === RelayerTransactionState.STATE_MINED ||
            transaction.state === RelayerTransactionState.STATE_CONFIRMED
        ) {
            logger.info(
                `自动回收已确认 conditions=${this.inflightConditionCount} txHash=${transaction.transactionHash}`
            );
            this.clearInflightTransaction();
            this.scheduleNextRun();
            return;
        }

        if (
            transaction.state === RelayerTransactionState.STATE_FAILED ||
            transaction.state === RelayerTransactionState.STATE_INVALID
        ) {
            logger.error(
                `自动回收失败 conditions=${this.inflightConditionCount} txHash=${transaction.transactionHash}`
            );
            this.clearInflightTransaction();
            this.scheduleNextRun(Math.max(this.intervalMs, FAILURE_BACKOFF_MS));
            return;
        }

        this.scheduleNextRun();
    }

    private async submitRedeemableBatch(allowAuthFallback = true) {
        if (!this.relayClient) {
            return;
        }

        const positions = await fetchData<UserPositionInterface[]>(PROXY_POSITIONS_URL);
        if (!Array.isArray(positions)) {
            this.scheduleNextRun();
            return;
        }

        const batches = groupRedeemablePositions(positions).slice(0, this.maxConditionsPerRun);
        if (batches.length === 0) {
            this.scheduleNextRun();
            return;
        }

        const estimatedPayout = batches.reduce((sum, batch) => sum + batch.estimatedPayout, 0);

        try {
            const response = await this.relayClient.execute(
                batches.map(buildRedeemTransaction),
                `auto redeem ${batches.length} conditions`
            );
            this.inflightTransactionId = response.transactionID;
            this.inflightTransactionHash = response.transactionHash || response.hash || '';
            this.inflightConditionCount = batches.length;
            logger.info(
                `提交自动回收 conditions=${batches.length} payout=${formatAmount(estimatedPayout)} ` +
                    `txId=${response.transactionID}` +
                    (this.inflightTransactionHash ? ` txHash=${this.inflightTransactionHash}` : '')
            );
            this.scheduleNextRun();
        } catch (error) {
            const reason = extractErrorMessage(error);
            if (allowAuthFallback && isAuthError(reason) && this.disableBuilderAuthFallback()) {
                await this.submitRedeemableBatch(false);
                return;
            }

            if (isAuthError(reason)) {
                this.redeemAuthUnavailable = true;
                logger.warn(
                    '自动回收鉴权失败，已在当前进程禁用 AUTO_REDEEM；请检查 relayer 权限或 builder 凭据'
                );
                this.clearInflightTransaction();
                this.scheduleNextRun(AUTH_ERROR_BACKOFF_MS);
                return;
            }

            logger.error(`自动回收提交失败 reason=${reason}`, error);
            this.clearInflightTransaction();
            this.scheduleNextRun(isAuthError(reason) ? AUTH_ERROR_BACKOFF_MS : FAILURE_BACKOFF_MS);
        }
    }

    private async loadResolutionSubjects() {
        const [pendingTrades, openBuffers, openBatches] = await Promise.all([
            UserActivity.find(
                {
                    $and: [
                        { type: 'TRADE' },
                        {
                            $or: [
                                { executionIntent: 'EXECUTE' },
                                { executionIntent: { $exists: false } },
                            ],
                        },
                        {
                            $or: [
                                { botStatus: { $exists: false } },
                                { botStatus: 'PENDING' },
                                { botStatus: 'BUFFERED' },
                                { botStatus: 'BATCHED' },
                            ],
                        },
                    ],
                },
                {
                    conditionId: 1,
                    title: 1,
                    slug: 1,
                    eventSlug: 1,
                }
            ).exec() as Promise<
                Array<Pick<UserActivityInterface, 'conditionId' | 'title' | 'slug' | 'eventSlug'>>
            >,
            CopyIntentBuffer.find(
                {
                    state: { $in: ['OPEN', 'FLUSHING'] },
                    conditionId: { $exists: true, $ne: '' },
                },
                {
                    conditionId: 1,
                    title: 1,
                }
            ).exec() as Promise<Array<Pick<CopyIntentBufferInterface, 'conditionId' | 'title'>>>,
            CopyExecutionBatch.find(
                {
                    status: { $in: ['READY', 'PROCESSING'] },
                    conditionId: { $exists: true, $ne: '' },
                },
                {
                    conditionId: 1,
                    title: 1,
                }
            ).exec() as Promise<Array<Pick<CopyExecutionBatchInterface, 'conditionId' | 'title'>>>,
        ]);

        const subjects = new Map<
            string,
            {
                conditionId: string;
                marketSlug: string;
                title: string;
            }
        >();
        const register = (subject: {
            conditionId?: string;
            title?: string;
            slug?: string;
            eventSlug?: string;
            marketSlug?: string;
        }) => {
            const conditionId = String(subject.conditionId || '').trim();
            if (!conditionId) {
                return;
            }

            const existing = subjects.get(conditionId) || {
                conditionId,
                marketSlug: '',
                title: '',
            };
            existing.marketSlug = existing.marketSlug || resolveMarketSlug(subject);
            existing.title = existing.title || String(subject.title || '').trim();
            subjects.set(conditionId, existing);
        };

        pendingTrades.forEach(register);
        openBuffers.forEach(register);
        openBatches.forEach(register);

        return [...subjects.values()];
    }

    private async skipResolvedPendingTrades(conditionId: string, reason: string) {
        const result = await UserActivity.updateMany(
            {
                $and: [
                    { conditionId },
                    { type: 'TRADE' },
                    {
                        $or: [
                            { executionIntent: 'EXECUTE' },
                            { executionIntent: { $exists: false } },
                        ],
                    },
                    {
                        $or: [{ botStatus: { $exists: false } }, { botStatus: 'PENDING' }],
                    },
                    {
                        $or: [{ botBufferId: { $exists: false } }, { botBufferId: null }],
                    },
                    {
                        $or: [
                            { botExecutionBatchId: { $exists: false } },
                            { botExecutionBatchId: null },
                        ],
                    },
                ],
            },
            {
                $set: {
                    bot: true,
                    botStatus: 'SKIPPED',
                    botExecutedAt: Date.now(),
                    botClaimedAt: 0,
                    botLastError: reason,
                },
            }
        );

        return result.modifiedCount;
    }

    private async cancelResolvedOpenBuffers(conditionId: string, reason: string) {
        const buffers = (await CopyIntentBuffer.find({
            conditionId,
            state: { $in: ['OPEN', 'FLUSHING'] },
        }).exec()) as CopyIntentBufferInterface[];

        for (const buffer of buffers) {
            await CopyIntentBuffer.updateOne(
                { _id: buffer._id },
                {
                    $set: {
                        state: 'SKIPPED',
                        claimedAt: 0,
                        reason,
                        completedAt: Date.now(),
                    },
                }
            );
            await UserActivity.updateMany(
                { _id: { $in: buffer.sourceTradeIds } },
                {
                    $set: {
                        bot: true,
                        botStatus: 'SKIPPED',
                        botClaimedAt: 0,
                        botExecutedAt: Date.now(),
                        botLastError: reason,
                    },
                }
            );
        }

        return buffers.length;
    }

    private async cancelResolvedReadyBatches(conditionId: string, reason: string) {
        const batches = (await CopyExecutionBatch.find({
            conditionId,
            status: { $in: ['READY', 'PROCESSING'] },
        }).exec()) as CopyExecutionBatchInterface[];

        for (const batch of batches) {
            await CopyExecutionBatch.updateOne(
                { _id: batch._id },
                {
                    $set: {
                        status: 'SKIPPED',
                        claimedAt: 0,
                        reason,
                        completedAt: Date.now(),
                        submissionStatus: 'SUBMITTED',
                    },
                }
            );
            await UserActivity.updateMany(
                { _id: { $in: batch.sourceTradeIds } },
                {
                    $set: {
                        bot: true,
                        botStatus: 'SKIPPED',
                        botClaimedAt: 0,
                        botExecutedAt: Date.now(),
                        botLastError: reason,
                    },
                }
            );
        }

        return batches.length;
    }

    private async sweepResolvedConditions() {
        const subjects = await this.loadResolutionSubjects();
        if (subjects.length === 0) {
            return;
        }

        for (const subject of subjects) {
            const resolution = await fetchPolymarketMarketResolution({
                conditionId: subject.conditionId,
                marketSlug: subject.marketSlug,
                title: subject.title,
            });
            if (!isResolvedPolymarketMarket(resolution)) {
                continue;
            }

            const reason = mergeReasons(
                buildResolvedSkipReason(resolution?.winnerOutcome || ''),
                resolution?.updateDescription || ''
            );
            const [pendingTradeCount, bufferCount, batchCount] = await Promise.all([
                this.skipResolvedPendingTrades(subject.conditionId, reason),
                this.cancelResolvedOpenBuffers(subject.conditionId, reason),
                this.cancelResolvedReadyBatches(subject.conditionId, reason),
            ]);

            if (pendingTradeCount > 0 || bufferCount > 0 || batchCount > 0) {
                logger.debug(
                    `resolved condition=${subject.conditionId} winner=${resolution?.winnerOutcome || 'unknown'} ` +
                        `skippedTrades=${pendingTradeCount} skippedBuffers=${bufferCount} skippedBatches=${batchCount}`
                );
            }
        }
    }

    async runDue() {
        if (this.running) {
            return;
        }

        this.running = true;
        try {
            await this.sweepResolvedConditions();
            await this.ensureRelayClient();

            if (!this.autoRedeemEnabled || !this.relayClient || this.redeemAuthUnavailable) {
                return;
            }

            if (Date.now() < this.nextRunAt) {
                return;
            }

            if (this.inflightTransactionId) {
                await this.syncInflightTransaction();
                return;
            }

            await this.submitRedeemableBatch();
        } finally {
            this.running = false;
        }
    }
}

export default LiveSettlementReclaimer;
