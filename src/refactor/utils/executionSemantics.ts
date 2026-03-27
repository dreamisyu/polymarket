import type { SourceActivityRecord } from '../infrastructure/polymarket/dto';

const paperExecutionTypes = new Set(['TRADE', 'MERGE', 'REDEEM']);
const liveExecutionTypes = new Set(['TRADE', 'MERGE']);

export const resolveTradeAction = (trade: Pick<SourceActivityRecord, 'side' | 'type'>) =>
    String(trade.side || trade.type || '').trim().toUpperCase();

export const resolveExecutionIntent = (
    trade: Pick<SourceActivityRecord, 'type'>,
    mode: 'live' | 'paper'
) => {
    const type = String(trade.type || '').trim().toUpperCase();
    const executableTypes = mode === 'paper' ? paperExecutionTypes : liveExecutionTypes;
    return executableTypes.has(type) ? 'EXECUTE' : 'SYNC_ONLY';
};
