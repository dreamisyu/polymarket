import { ExecutionPolicyTrailEntry } from '../interfaces/Execution';

export const buildPolicyTrailEntry = (
    policyId: string,
    action: ExecutionPolicyTrailEntry['action'],
    reason: string
): ExecutionPolicyTrailEntry => ({
    policyId,
    action,
    reason,
    timestamp: Date.now(),
});

export const mergePolicyTrail = (
    ...groups: Array<ExecutionPolicyTrailEntry[] | undefined>
): ExecutionPolicyTrailEntry[] => {
    const merged = groups.flatMap((group) => group || []);
    const seen = new Set<string>();
    return merged.filter((entry) => {
        const key = `${entry.policyId}:${entry.action}:${entry.reason}`;
        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
};

export const hasPolicyId = (
    policyTrail: ExecutionPolicyTrailEntry[] | undefined,
    policyIds: string[]
) => {
    const policyIdSet = new Set(policyIds);
    return (policyTrail || []).some((entry) => policyIdSet.has(entry.policyId));
};
