import {
    fetchPolymarketMarketResolution,
    isResolvedPolymarketMarket,
    normalizeOutcomeLabel,
} from '../../../utils/polymarketMarketResolution';
import type { LedgerStore, SettlementGateway, SettlementTaskStore } from '../runtime/contracts';
import { buildPortfolioSnapshot } from '../trading/shared';

export class PaperSettlementGateway implements SettlementGateway {
    private readonly settlementTasks: SettlementTaskStore;
    private readonly ledgerStore: LedgerStore;

    constructor(params: { settlementTasks: SettlementTaskStore; ledgerStore: LedgerStore }) {
        this.settlementTasks = params.settlementTasks;
        this.ledgerStore = params.ledgerStore;
    }

    async runDue() {
        const now = Date.now();
        const task = await this.settlementTasks.claimDue(now);
        if (!task || !task._id) {
            return;
        }

        const resolution = await fetchPolymarketMarketResolution({
            conditionId: task.conditionId,
            marketSlug: task.marketSlug,
            title: task.title,
        });

        if (!isResolvedPolymarketMarket(resolution)) {
            await this.settlementTasks.markRetry(
                String(task._id),
                '市场尚未 resolved，等待下次结算轮次',
                now,
                30_000
            );
            return;
        }

        const positions = await this.ledgerStore.listPositions();
        const remainedPositions = [];
        const targetPositions = positions.filter((position) => position.conditionId === task.conditionId);
        const untouchedPositions = positions.filter((position) => position.conditionId !== task.conditionId);
        const winnerOutcome = normalizeOutcomeLabel(resolution?.winnerOutcome || '');
        const portfolio = await this.ledgerStore.getPortfolio();
        let nextCashBalance = portfolio.cashBalance;
        let nextRealizedPnl = portfolio.realizedPnl;

        for (const position of targetPositions) {
            const isWinner = normalizeOutcomeLabel(position.outcome) === winnerOutcome;
            const cashDelta = isWinner ? position.size : 0;
            const realizedPnlDelta = cashDelta - position.costBasis;
            nextCashBalance += cashDelta;
            nextRealizedPnl += realizedPnlDelta;
            await this.ledgerStore.deletePosition(position.asset);
        }

        remainedPositions.push(...untouchedPositions);
        const nextPortfolio = buildPortfolioSnapshot(nextCashBalance, nextRealizedPnl, remainedPositions);
        await this.ledgerStore.savePortfolio(nextPortfolio);
        await this.settlementTasks.markSettled(
            String(task._id),
            resolution?.winnerOutcome || '',
            `市场已 resolved winner=${resolution?.winnerOutcome || 'unknown'}`,
            now
        );
    }
}
