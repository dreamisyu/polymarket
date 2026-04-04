import { describe, expect, it, jest } from '@jest/globals';
import type { SourceTradeEvent } from '@domain';
import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import { MergePlanningNode } from '@domain/nodes/copytrade/MergePlanningNode';
import {
    computeMirrorDecision,
    computeProportionalDecision,
} from '@domain/strategy/strategySizing';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { buildTestConfig } from '@/__tests__/testFactories';

jest.mock('@polymarket/clob-client', () => ({
    Side: {
        BUY: 'BUY',
        SELL: 'SELL',
    },
    TickSize: {
        ONE_CENT: '0.01',
    },
}));

const buildEvent = (overrides: Partial<SourceTradeEvent> = {}): SourceTradeEvent => ({
    _id: '507f1f77bcf86cd799439011' as never,
    sourceWallet: '0xtarget',
    activityKey: 'activity-1',
    timestamp: Date.now(),
    type: 'TRADE',
    side: 'BUY',
    action: 'buy',
    transactionHash: '0xhash',
    conditionId: 'condition-1',
    asset: 'asset-1',
    outcome: 'Yes',
    outcomeIndex: 0,
    title: 'market-1',
    slug: 'market-1',
    eventSlug: 'event-1',
    price: 0.5,
    size: 10,
    usdcSize: 5,
    executionIntent: 'EXECUTE',
    sourceBalanceBeforeTrade: 100,
    sourceBalanceAfterTrade: 95,
    sourcePositionSizeBeforeTrade: 20,
    sourcePositionSizeAfterTrade: 10,
    sourceConditionMergeableSizeBeforeTrade: 20,
    sourceConditionMergeableSizeAfterTrade: 10,
    raw: {},
    ...overrides,
});

const buildMergeContext = (strategyKind: 'mirror' | 'proportional') =>
    ({
        workflowId: `copytrade:${strategyKind}:merge-1`,
        workflowKind: 'copytrade',
        runMode: 'paper',
        strategyKind,
        runtime: {
            config: buildTestConfig({
                strategyKind,
                proportionalCopyRatio: 0.5,
                autoRedeemEnabled: false,
                autoRedeemMaxConditionsPerRun: 1,
            }),
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
            workflowEngine: {} as never,
            stores: {
                sourceEvents: {} as never,
                executions: {} as never,
                settlementTasks: {} as never,
            },
            gateways: {
                monitor: {} as never,
                trading: {
                    listConditionPositions: jest.fn(async () => ({
                        conditionId: 'condition-1',
                        mergeableSize: 8,
                        positions: [
                            { asset: 'asset-1', size: 8 },
                            { asset: 'asset-2', size: 8 },
                        ],
                    })),
                } as never,
                settlement: {} as never,
            },
        },
        state: {
            sourceEvent: buildEvent({ action: 'merge', side: 'SELL', usdcSize: 10, size: 10 }),
            policyTrail: [],
        },
        startedAt: Date.now(),
        now: () => Date.now(),
    }) as unknown as NodeContext<CopyTradeWorkflowState>;

describe('strategySizing', () => {
    it('mirror 策略买入按源账户余额比例镜像', () => {
        const decision = computeMirrorDecision(buildEvent({ usdcSize: 40 }), 50, 0, {
            maxOrderUsdc: 0,
        });

        expect(decision.status).toBe('ready');
        expect(decision.requestedUsdc).toBeCloseTo(20, 6);
    });

    it('proportional 策略买入按配置比例缩放', () => {
        const decision = computeProportionalDecision(buildEvent({ usdcSize: 100 }), 200, 0, {
            proportionalCopyRatio: 0.5,
            maxOrderUsdc: 0,
        });

        expect(decision.status).toBe('ready');
        expect(decision.requestedUsdc).toBeCloseTo(50, 6);
        expect(decision.note).toContain('50.00%');
    });

    it('proportional 策略卖出会按比例缩放并受本地仓位限制', () => {
        const decision = computeProportionalDecision(
            buildEvent({ action: 'sell', side: 'SELL', size: 10 }),
            0,
            3,
            {
                proportionalCopyRatio: 0.5,
                maxOrderUsdc: 0,
            }
        );

        expect(decision.status).toBe('ready');
        expect(decision.requestedSize).toBeCloseTo(3, 6);
    });
});

describe('MergePlanningNode', () => {
    it('mirror 策略沿用源账户 merge 比例', async () => {
        const node = new MergePlanningNode();
        const ctx = buildMergeContext('mirror');

        const result = await node.doAction(ctx);

        expect(result.status).toBe('success');
        expect(ctx.state.sizingDecision?.requestedSize).toBeCloseTo(4, 6);
        expect(ctx.state.policyTrail).toContain('merge:mirror');
    });

    it('proportional 策略按配置比例缩放 merge 数量', async () => {
        const node = new MergePlanningNode();
        const ctx = buildMergeContext('proportional');

        const result = await node.doAction(ctx);

        expect(result.status).toBe('success');
        expect(ctx.state.sizingDecision?.requestedSize).toBeCloseTo(5, 6);
        expect(ctx.state.policyTrail).toContain('merge:proportional');
    });
});
