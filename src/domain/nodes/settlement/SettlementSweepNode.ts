import type { PositionSnapshot, SettlementTask } from '@domain';
import { buildPortfolioSnapshot } from '@infrastructure/trading/shared';
import {
    fetchMarketResolution,
    isResolvedMarket,
    normalizeOutcomeLabel,
} from '@shared/resolution';
import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import { BaseNode } from '@domain/nodes/kernel/BaseNode';

const buildResolvedReason = (winnerOutcome: string) =>
    `市场已 resolved winner=${winnerOutcome || 'unknown'}，已停止未完成跟单并开始结算`;

const buildIndexSets = (positions: PositionSnapshot[]) =>
    [
        ...new Set(
            positions
                .filter((position) => Number(position.size) > 0)
                .map((position) => 1n << BigInt(Number(position.outcomeIndex) || 0))
        ),
    ].sort((left, right) => Number(left - right));

export class SettlementSweepNode extends BaseNode {
    constructor() {
        super('settlement.sweep');
    }

    async doAction(ctx: NodeContext): Promise<NodeResult> {
        if (!ctx.runtime.config.autoRedeemEnabled) {
            return this.skip('AUTO_REDEEM_ENABLED=false，已跳过结算工作流', null);
        }

        let handledCount = 0;
        let closedCount = 0;
        let settledCount = 0;
        let retryCount = 0;
        const maxTasksPerRun = Math.max(ctx.runtime.config.settlementMaxTasksPerRun || 1, 1);

        while (handledCount < maxTasksPerRun) {
            const task = await ctx.runtime.stores.settlementTasks.claimDue(ctx.now());
            if (!task || !task._id) {
                break;
            }

            const outcome = await this.handleTask(ctx, task);
            handledCount += 1;
            if (outcome === 'closed') {
                closedCount += 1;
            } else if (outcome === 'settled') {
                settledCount += 1;
            } else {
                retryCount += 1;
            }
        }

        const reason =
            handledCount > 0
                ? `结算轮次执行完成，处理 ${handledCount} 个任务`
                : '结算轮次执行完成，无到期任务';
        return this.success(
            {
                handledCount,
                closedCount,
                settledCount,
                retryCount,
                maxTasksPerRun,
            },
            null,
            reason
        );
    }

    private async handleTask(ctx: NodeContext, task: SettlementTask) {
        const now = ctx.now();
        const taskId = String(task._id);
        const resolution = await fetchMarketResolution(
            {
                conditionId: task.conditionId,
                marketSlug: task.marketSlug,
                title: task.title,
            },
            ctx.runtime.config
        );
        if (!isResolvedMarket(resolution)) {
            await ctx.runtime.stores.settlementTasks.markRetry(
                taskId,
                '市场尚未 resolved，等待下次结算轮次',
                now,
                ctx.runtime.config.settlementIntervalMs
            );
            return 'retry' as const;
        }

        const winnerOutcome = String(resolution?.winnerOutcome || '').trim();
        const resolvedReason = buildResolvedReason(winnerOutcome);
        await ctx.runtime.stores.sourceEvents.skipOutstandingByCondition(
            task.conditionId,
            resolvedReason,
            now
        );

        if (ctx.runMode === 'paper') {
            return this.handlePaperTask(ctx, task, winnerOutcome, resolvedReason, now);
        }

        return this.handleLiveTask(ctx, task, winnerOutcome, resolvedReason, now);
    }

    private async handlePaperTask(
        ctx: NodeContext,
        task: SettlementTask,
        winnerOutcome: string,
        resolvedReason: string,
        now: number
    ) {
        const ledger = ctx.runtime.stores.ledger;
        if (!ledger) {
            throw new Error('paper 模式缺少账本存储');
        }
        if (!winnerOutcome) {
            await ctx.runtime.stores.settlementTasks.markRetry(
                String(task._id),
                '市场已 resolved 但 winner outcome 未知，稍后重试',
                now,
                ctx.runtime.config.retryBackoffMs
            );
            return 'retry' as const;
        }

        const [portfolio, positions] = await Promise.all([
            ledger.getPortfolio(),
            ledger.listPositions(),
        ]);
        const targetPositions = positions.filter(
            (position) => position.conditionId === task.conditionId
        );
        if (targetPositions.length === 0) {
            await ctx.runtime.stores.settlementTasks.markClosed(
                String(task._id),
                winnerOutcome,
                `${resolvedReason}；本地无待回收仓位`,
                now
            );
            return 'closed' as const;
        }

        const untouchedPositions = positions.filter(
            (position) => position.conditionId !== task.conditionId
        );
        const normalizedWinner = normalizeOutcomeLabel(winnerOutcome);
        let nextCashBalance = portfolio.cashBalance;
        let nextRealizedPnl = portfolio.realizedPnl;

        for (const position of targetPositions) {
            const isWinner = normalizeOutcomeLabel(position.outcome) === normalizedWinner;
            const cashDelta = isWinner ? position.size : 0;
            const realizedPnlDelta = cashDelta - position.costBasis;
            nextCashBalance += cashDelta;
            nextRealizedPnl += realizedPnlDelta;
            await ledger.deletePosition(position.asset);
        }

        await ledger.savePortfolio(
            buildPortfolioSnapshot(nextCashBalance, nextRealizedPnl, untouchedPositions)
        );
        await ctx.runtime.stores.settlementTasks.markClosed(
            String(task._id),
            winnerOutcome,
            resolvedReason,
            now
        );
        return 'closed' as const;
    }

    private async handleLiveTask(
        ctx: NodeContext,
        task: SettlementTask,
        winnerOutcome: string,
        resolvedReason: string,
        now: number
    ) {
        const conditionSnapshot = await ctx.runtime.gateways.trading.listConditionPositions(
            task.conditionId
        );
        const positions = conditionSnapshot.positions.filter(
            (position) => Number(position.size) > 0
        );
        if (positions.length === 0) {
            await ctx.runtime.stores.settlementTasks.markClosed(
                String(task._id),
                winnerOutcome,
                `${resolvedReason}；本地无待回收仓位`,
                now
            );
            return 'closed' as const;
        }

        if (!ctx.runtime.config.liveSettlementOnchainRedeemEnabled) {
            await ctx.runtime.stores.settlementTasks.markClosed(
                String(task._id),
                winnerOutcome,
                `${resolvedReason}；配置禁用链上回收，未发送 redeem tx`,
                now
            );
            return 'closed' as const;
        }

        const redeemablePositions = positions.filter((position) => Boolean(position.redeemable));
        if (redeemablePositions.length === 0) {
            await ctx.runtime.stores.settlementTasks.markSettled(
                String(task._id),
                winnerOutcome,
                `${resolvedReason}；本地仓位尚未转为 redeemable，等待下轮补清`,
                now,
                ctx.runtime.config.settlementIntervalMs
            );
            return 'settled' as const;
        }

        const indexSets = buildIndexSets(redeemablePositions);
        if (indexSets.length === 0) {
            await ctx.runtime.stores.settlementTasks.markSettled(
                String(task._id),
                winnerOutcome,
                `${resolvedReason}；缺少可回收 outcome partition，等待下轮补清`,
                now,
                ctx.runtime.config.settlementIntervalMs
            );
            return 'settled' as const;
        }

        const redeemResult = await ctx.runtime.gateways.settlement.executeRedeem({
            conditionId: task.conditionId,
            positions: redeemablePositions,
            indexSets,
        });
        if (redeemResult.status === 'confirmed') {
            await ctx.runtime.stores.settlementTasks.markClosed(
                String(task._id),
                winnerOutcome,
                `${resolvedReason}；${redeemResult.reason}`,
                now
            );
            return 'closed' as const;
        }

        if (redeemResult.status === 'failed') {
            await ctx.runtime.stores.settlementTasks.markClosed(
                String(task._id),
                winnerOutcome,
                `${resolvedReason}；${redeemResult.reason}`,
                now
            );
            return 'closed' as const;
        }

        await ctx.runtime.stores.settlementTasks.markRetry(
            String(task._id),
            redeemResult.reason,
            now,
            ctx.runtime.config.retryBackoffMs
        );
        return 'retry' as const;
    }
}
