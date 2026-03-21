import { ENV } from '../config/env';
import { ExecutionIntent } from '../interfaces/User';
import { UserActivityInterface } from '../interfaces/User';
import { toSafeNumber } from './runtime';

export type SnapshotValidationMode = 'trace' | 'live';

const TRACE_EXECUTION_ACTIVITY_TYPES = new Set(['TRADE', 'MERGE', 'REDEEM']);
const LIVE_EXECUTION_ACTIVITY_TYPES = new Set(['TRADE', 'MERGE']);

export const resolveTradeAction = (trade: Pick<UserActivityInterface, 'side' | 'type'>) =>
    String(trade.side || trade.type || '')
        .trim()
        .toUpperCase();

export const resolveExecutionIntent = (
    trade: Pick<UserActivityInterface, 'type'>,
    mode: SnapshotValidationMode = ENV.EXECUTION_MODE
): ExecutionIntent => {
    const type = String(trade.type || '')
        .trim()
        .toUpperCase();
    const executableTypes =
        mode === 'trace' ? TRACE_EXECUTION_ACTIVITY_TYPES : LIVE_EXECUTION_ACTIVITY_TYPES;
    return executableTypes.has(type) ? 'EXECUTE' : 'SYNC_ONLY';
};

export const validateExecutableSnapshot = (
    trade: Pick<
        UserActivityInterface,
        'snapshotStatus' | 'sourceSnapshotCapturedAt' | 'sourceSnapshotReason'
    >,
    params: {
        mode: SnapshotValidationMode;
        now?: number;
        maxLiveStaleSnapshotMs?: number;
    }
) => {
    const snapshotStatus = String(trade.snapshotStatus || '')
        .trim()
        .toUpperCase();
    if (snapshotStatus === 'PARTIAL') {
        return {
            status: 'RETRY' as const,
            reason: trade.sourceSnapshotReason || '源账户快照尚未完整',
        };
    }

    if (params.mode === 'live' && snapshotStatus === 'STALE') {
        const capturedAt = toSafeNumber(trade.sourceSnapshotCapturedAt);
        if (capturedAt <= 0) {
            return {
                status: 'RETRY' as const,
                reason: '陈旧快照缺少采样时间，暂缓真实执行',
            };
        }

        const maxLiveStaleSnapshotMs = Math.max(toSafeNumber(params.maxLiveStaleSnapshotMs), 0);
        const snapshotAgeMs = Math.max((params.now || Date.now()) - capturedAt, 0);
        if (maxLiveStaleSnapshotMs > 0 && snapshotAgeMs > maxLiveStaleSnapshotMs) {
            return {
                status: 'RETRY' as const,
                reason: `源账户快照已陈旧 ${snapshotAgeMs}ms，超过 live 允许上限 ${maxLiveStaleSnapshotMs}ms`,
            };
        }
    }

    return {
        status: 'OK' as const,
        reason: '',
    };
};
