import type { RuntimeConfig } from '../../config/runtimeConfig';
import { confirmTransactionHashes } from '../chain/confirm';
import { submitRedeemPositions } from '../chain/ctf';
import { fetchUserPositions } from '../polymarket/api';
import { fetchMarketResolution, isResolvedMarket } from '../../utils/resolution';
import type {
    LoggerLike,
    SettlementGateway,
    SettlementTaskStore,
    SourceEventStore,
} from '../runtime/contracts';

const isBytes32Hex = (value: string) => /^0x[a-fA-F0-9]{64}$/.test(value);

export class LiveSettlementGateway implements SettlementGateway {
    private readonly config: RuntimeConfig;
    private readonly logger: LoggerLike;
    private readonly sourceEvents: SourceEventStore;
    private readonly settlementTasks: SettlementTaskStore;

    constructor(params: {
        config: RuntimeConfig;
        logger: LoggerLike;
        sourceEvents: SourceEventStore;
        settlementTasks: SettlementTaskStore;
    }) {
        this.config = params.config;
        this.logger = params.logger;
        this.sourceEvents = params.sourceEvents;
        this.settlementTasks = params.settlementTasks;
    }

    async runDue() {
        const now = Date.now();
        const task = await this.settlementTasks.claimDue(now);
        if (!task || !task._id) {
            return;
        }

        const resolution = await fetchMarketResolution(
            {
                conditionId: task.conditionId,
                marketSlug: task.marketSlug,
                title: task.title,
            },
            this.config
        );
        if (!isResolvedMarket(resolution)) {
            await this.settlementTasks.markRetry(
                String(task._id),
                '市场尚未 resolved，等待下次结算轮次',
                now,
                this.config.settlementIntervalMs
            );
            return;
        }

        const reason = `市场已 resolved winner=${resolution?.winnerOutcome || 'unknown'}，已停止未完成跟单并开始回收`;
        await this.sourceEvents.skipOutstandingByCondition(task.conditionId, reason, now);

        const positions = (await fetchUserPositions(this.config.targetWallet, this.config)) || [];
        const targetPositions = positions.filter(
            (position) =>
                String(position.conditionId || '').trim() === task.conditionId &&
                Boolean(position.redeemable) &&
                Number(position.size) > 0
        );

        if (targetPositions.length === 0) {
            await this.settlementTasks.markSettled(
                String(task._id),
                resolution?.winnerOutcome || '',
                `${reason}；本地无可回收仓位`,
                now
            );
            return;
        }

        if (!isBytes32Hex(task.conditionId)) {
            await this.settlementTasks.markRetry(
                String(task._id),
                'conditionId 非法，无法提交 redeem',
                now,
                this.config.retryBackoffMs
            );
            return;
        }

        const indexSets = [...new Set(targetPositions.map((position) => 1n << BigInt(Number(position.outcomeIndex) || 0)))].sort(
            (left, right) => Number(left - right)
        );
        if (indexSets.length === 0) {
            await this.settlementTasks.markSettled(
                String(task._id),
                resolution?.winnerOutcome || '',
                `${reason}；本地无可回收 outcome`,
                now
            );
            return;
        }

        try {
            const hash = await submitRedeemPositions(
                {
                    conditionId: task.conditionId,
                    indexSets,
                },
                this.config
            );
            const confirmation = await confirmTransactionHashes([hash], this.config, {
                timeoutMs: this.config.liveConfirmTimeoutMs,
            });
            if (confirmation.status === 'CONFIRMED') {
                await this.settlementTasks.markSettled(
                    String(task._id),
                    resolution?.winnerOutcome || '',
                    `${reason}；redeem 已确认 tx=${hash}`,
                    now
                );
                return;
            }

            await this.settlementTasks.markRetry(
                String(task._id),
                confirmation.reason || 'redeem 未确认，稍后重试',
                now,
                this.config.retryBackoffMs
            );
        } catch (error) {
            this.logger.error(`提交 live redeem 失败 condition=${task.conditionId}`, error);
            await this.settlementTasks.markRetry(
                String(task._id),
                (error as { message?: string })?.message || '提交 live redeem 失败',
                now,
                this.config.retryBackoffMs
            );
        }
    }
}
