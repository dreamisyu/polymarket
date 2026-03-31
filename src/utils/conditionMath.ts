import { normalizeOutcomeLabel } from '@domain/market/outcomeLabel';
import { toSafeNumber } from '@shared/math';

export const buildConditionOutcomeKey = (params: {
    asset?: string;
    outcomeIndex?: number;
    outcome?: string;
}) => {
    const asset = String(params.asset || '').trim();
    if (asset) {
        return `asset:${asset}`;
    }

    const outcomeIndex = Number(params.outcomeIndex);
    if (Number.isInteger(outcomeIndex) && outcomeIndex >= 0) {
        return `idx:${outcomeIndex}`;
    }

    const outcome = normalizeOutcomeLabel(String(params.outcome || '').trim());
    if (outcome) {
        return `outcome:${outcome}`;
    }

    return '';
};

export const computeConditionMergeableSize = (
    outcomeKeys: string[],
    sizeByOutcomeKey: Map<string, number>
) => {
    const normalizedKeys = [
        ...new Set(outcomeKeys.map((key) => String(key || '').trim()).filter(Boolean)),
    ];
    if (normalizedKeys.length < 2) {
        return 0;
    }

    let mergeableSize = Number.POSITIVE_INFINITY;
    for (const outcomeKey of normalizedKeys) {
        mergeableSize = Math.min(
            mergeableSize,
            Math.max(toSafeNumber(sizeByOutcomeKey.get(outcomeKey)), 0)
        );
    }

    return Number.isFinite(mergeableSize) ? mergeableSize : 0;
};
