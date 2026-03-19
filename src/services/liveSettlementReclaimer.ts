import {
    RelayClient,
    RelayerTransaction,
    RelayerTransactionState,
    RelayerTxType,
    Transaction,
} from '@polymarket/builder-relayer-client';
import { BuilderApiKeyCreds, BuilderConfig } from '@polymarket/builder-signing-sdk';
import { UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import createLogger from '../utils/logger';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { Address, Hex, createWalletClient, encodeFunctionData, http, zeroHash } from 'viem';

const logger = createLogger('settlement');
const RELAYER_CHAIN_ID = 137;
const PROXY_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}&sizeThreshold=0`;
const AUTH_ERROR_BACKOFF_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 1000;

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

const buildBuilderConfig = () => {
    const creds: BuilderApiKeyCreds = {
        key: ENV.POLY_BUILDER_API_KEY,
        secret: ENV.POLY_BUILDER_SECRET,
        passphrase: ENV.POLY_BUILDER_PASSPHRASE,
    };

    if (!creds.key || !creds.secret || !creds.passphrase) {
        return undefined;
    }

    return new BuilderConfig({
        localBuilderCreds: creds,
    });
};

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

class LiveSettlementReclaimer {
    private readonly enabled = ENV.AUTO_REDEEM_ENABLED;
    private readonly intervalMs = ENV.AUTO_REDEEM_INTERVAL_MS;
    private readonly maxConditionsPerRun = ENV.AUTO_REDEEM_MAX_CONDITIONS_PER_RUN;
    private readonly relayClient: RelayClient | null;
    private running = false;
    private nextRunAt = 0;
    private inflightTransactionId = '';
    private inflightTransactionHash = '';
    private inflightConditionCount = 0;

    constructor() {
        if (!this.enabled) {
            this.relayClient = null;
            return;
        }

        const walletClient = createWalletClient({
            account: privateKeyToAccount(normalizePrivateKey(ENV.PRIVATE_KEY)),
            chain: polygon,
            transport: http(ENV.RPC_URL),
        });
        const txType =
            ENV.POLYMARKET_RELAYER_TX_TYPE === 'PROXY' ? RelayerTxType.PROXY : RelayerTxType.SAFE;
        this.relayClient = new RelayClient(
            ENV.POLYMARKET_RELAYER_URL,
            RELAYER_CHAIN_ID,
            walletClient,
            buildBuilderConfig(),
            txType
        );
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

    private async submitRedeemableBatch() {
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
            logger.error(`自动回收提交失败 reason=${reason}`, error);
            this.clearInflightTransaction();
            this.scheduleNextRun(isAuthError(reason) ? AUTH_ERROR_BACKOFF_MS : FAILURE_BACKOFF_MS);
        }
    }

    async runDue() {
        if (!this.enabled || !this.relayClient || this.running) {
            return;
        }

        if (Date.now() < this.nextRunAt) {
            return;
        }

        this.running = true;
        try {
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
