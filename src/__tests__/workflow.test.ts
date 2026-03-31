import { describe, expect, it, jest } from '@jest/globals';
import { BaseNode } from '@domain/nodes/kernel/BaseNode';
import { NodeChainBuilder } from '@domain/nodes/kernel/NodeChainBuilder';
import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import { NodeRegistry } from '@domain/nodes/kernel/NodeRegistry';
import { NodeWorkflowEngine } from '@domain/nodes/kernel/NodeWorkflowEngine';
import { RiskGuardNode } from '@domain/nodes/copytrade/RiskGuardNode';
import { DispatchCopyTradeNode } from '@domain/nodes/monitor/DispatchCopyTradeNode';
import { PrepareDispatchBundlesNode } from '@domain/nodes/monitor/PrepareDispatchBundlesNode';
import { buildCopyTradeDispatchItems } from '@shared/copytradeDispatch';
import { buildTestConfig } from '@/__tests__/testFactories';

class TestNode extends BaseNode {
    private readonly handler: (ctx: NodeContext) => Promise<NodeResult>;

    constructor(id: string, handler: (ctx: NodeContext) => Promise<NodeResult>) {
        super(id);
        this.handler = handler;
    }

    async doAction(ctx: NodeContext) {
        return this.handler(ctx);
    }
}

const buildTestContext = (): NodeContext => ({
    workflowId: 'test',
    workflowKind: 'copytrade',
    runMode: 'paper',
    strategyKind: 'fixed_amount',
    runtime: {
        config: buildTestConfig({
            autoRedeemEnabled: false,
            autoRedeemMaxConditionsPerRun: 1,
        }),
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        } as never,
        workflowEngine: {} as never,
        stores: {
            sourceEvents: {} as never,
            executions: {} as never,
            settlementTasks: {} as never,
        },
        gateways: {
            monitor: {} as never,
            trading: {} as never,
            settlement: {} as never,
        },
    },
    state: {},
    startedAt: Date.now(),
    now: () => Date.now(),
});

describe('NodeChainBuilder', () => {
    it('支持 before / after 扩展拍平', () => {
        const workflow = new NodeChainBuilder()
            .append('a')
            .append('b')
            .before('b', 'before-b')
            .after('b', 'after-b')
            .build();

        expect(workflow.headNodeId).toBe('a');
        expect(workflow.transitions.get('a')?.success).toBe('before-b');
        expect(workflow.transitions.get('before-b')?.success).toBe('b');
        expect(workflow.transitions.get('b')?.success).toBe('after-b');
    });
});

describe('NodeWorkflowEngine', () => {
    it('按路由顺序执行节点', async () => {
        const visited: string[] = [];
        const registry = new NodeRegistry();
        registry.register(
            new TestNode('a', async () => {
                visited.push('a');
                return { status: 'success' };
            })
        );
        registry.register(
            new TestNode('b', async () => {
                visited.push('b');
                return { status: 'success', next: null };
            })
        );

        const workflow = new NodeChainBuilder().append('a').append('b').build();
        const engine = new NodeWorkflowEngine(registry);
        const summary = await engine.run(buildTestContext(), workflow);

        expect(visited).toEqual(['a', 'b']);
        expect(summary.lastNodeId).toBe('b');
    });

    it('异步派发会遵守并发上限', async () => {
        const registry = new NodeRegistry();
        const started: string[] = [];
        const releases = new Map<string, () => void>();

        registry.register(
            new TestNode('slow', async (ctx) => {
                started.push(String(ctx.workflowId));
                await new Promise<void>((resolve) => {
                    releases.set(String(ctx.workflowId), resolve);
                });
                return { status: 'success', next: null };
            })
        );

        const engine = new NodeWorkflowEngine(registry, { detachedConcurrency: 2 });
        const workflow = new NodeChainBuilder().append('slow').build();

        engine.runDetached({ ...buildTestContext(), workflowId: 'job-1' }, workflow);
        engine.runDetached({ ...buildTestContext(), workflowId: 'job-2' }, workflow);
        engine.runDetached({ ...buildTestContext(), workflowId: 'job-3' }, workflow);

        await Promise.resolve();

        expect(started).toEqual(['job-1', 'job-2']);

        releases.get('job-1')?.();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(started).toEqual(['job-1', 'job-2', 'job-3']);

        releases.get('job-2')?.();
        releases.get('job-3')?.();
    });
});

describe('DispatchCopyTradeNode', () => {
    it('只异步派发已准备好的 dispatch items', async () => {
        const runDetached = jest.fn();
        const node = new DispatchCopyTradeNode({
            resolveEngine: () => ({ runDetached }) as unknown as NodeWorkflowEngine,
            resolveWorkflow: () => ({ headNodeId: 'copytrade.context', transitions: new Map() }),
            buildCopyTradeContext: (dispatchItem) =>
                ({
                    ...buildTestContext(),
                    workflowId: `copytrade:${dispatchItem.dispatchId}`,
                    workflowKind: 'copytrade',
                    state: {
                        sourceEvent: dispatchItem.sourceEvent,
                        sourceEvents: dispatchItem.sourceEvents,
                    },
                }) as NodeContext,
        });

        const ctx = {
            ...buildTestContext(),
            workflowId: 'monitor:test',
            workflowKind: 'monitor',
            state: {
                dispatchItems: [
                    {
                        dispatchId: 'bundle:1',
                        aggregated: true,
                        sourceEvent: {
                            activityKey: 'bundle:1',
                        },
                        sourceEvents: [
                            {
                                _id: '1',
                                activityKey: 'execute-1',
                                executionIntent: 'EXECUTE',
                            },
                        ],
                    },
                ],
            },
        } as unknown as NodeContext;

        const result = await node.doAction(ctx);

        expect(result.status).toBe('success');
        expect(runDetached).toHaveBeenCalledTimes(1);
        expect((runDetached.mock.calls[0]?.[0] as NodeContext).workflowId).toBe(
            'copytrade:bundle:1'
        );
    });
});

describe('PrepareDispatchBundlesNode', () => {
    it('claim retry 事件时会带上 processing 租约配置', async () => {
        const claimDueRetries = jest.fn(async () => []);
        const node = new PrepareDispatchBundlesNode();
        const ctx = {
            ...buildTestContext(),
            workflowId: 'monitor:test',
            workflowKind: 'monitor',
            runtime: {
                ...buildTestContext().runtime,
                stores: {
                    ...buildTestContext().runtime.stores,
                    sourceEvents: {
                        ...buildTestContext().runtime.stores.sourceEvents,
                        claimDueRetries,
                    },
                },
            },
            state: {
                newEvents: [],
            },
        } as unknown as NodeContext;

        const result = await node.doAction(ctx);

        expect(result.status).toBe('success');
        expect((claimDueRetries as jest.Mock).mock.calls[0]).toEqual([
            expect.any(Number),
            100,
            {
                processingLeaseMs: 300_000,
                maxRetryCount: 3,
            },
        ]);
    });
});

describe('RiskGuardNode', () => {
    it('市场白名单命中失败时跳过买入信号', async () => {
        const node = new RiskGuardNode();
        const ctx = {
            ...buildTestContext(),
            runtime: {
                ...buildTestContext().runtime,
                config: {
                    ...buildTestContext().runtime.config,
                    marketWhitelist: ['crypto_updown_5m'],
                },
            },
            state: {
                sourceEvent: {
                    action: 'buy',
                    timestamp: 1774713000000,
                    usdcSize: 20,
                    eventSlug: 'fed-rate-cut-june',
                    slug: 'fed-rate-cut-june',
                    title: 'Will the Fed cut rates in June?',
                },
                portfolio: {
                    openPositionCount: 0,
                    activeExposureUsdc: 0,
                },
                localPosition: null,
                policyTrail: [],
            },
        } as unknown as NodeContext;

        const result = await node.doAction(ctx);

        expect(result.status).toBe('skip');
        expect(result.reason).toBe('市场不在白名单内，已跳过买入信号');
        expect(ctx.state.policyTrail).toContain('risk:market_whitelist');
    });

    it('源买入金额过小时跳过买入信号', async () => {
        const node = new RiskGuardNode();
        const ctx = {
            ...buildTestContext(),
            runtime: {
                ...buildTestContext().runtime,
                config: {
                    ...buildTestContext().runtime.config,
                    minSourceBuyUsdc: 5,
                },
            },
            state: {
                sourceEvent: {
                    action: 'buy',
                    timestamp: 1774713000000,
                    usdcSize: 4.2,
                    eventSlug: 'eth-updown-5m-1774712700',
                    slug: 'eth-updown-5m-1774712700',
                    title: 'Ethereum Up or Down - March 28, 11:45AM-11:50AM ET',
                },
                portfolio: {
                    openPositionCount: 0,
                    activeExposureUsdc: 0,
                },
                localPosition: null,
                policyTrail: [],
            },
        } as unknown as NodeContext;

        const result = await node.doAction(ctx);

        expect(result.status).toBe('skip');
        expect(result.reason).toBe('源买入金额低于最小阈值 5 USDC，已跳过');
        expect(ctx.state.policyTrail).toContain('risk:min_source_buy_usdc');
    });

    it('信号过期时跳过迟到买单', async () => {
        const node = new RiskGuardNode();
        const ctx = {
            ...buildTestContext(),
            now: () => 1774713120000,
            state: {
                sourceEvent: {
                    action: 'buy',
                    timestamp: 1774713000000,
                    eventSlug: 'btc-updown-15m-1774712700',
                    slug: 'btc-updown-15m-1774712700',
                },
                portfolio: {
                    openPositionCount: 0,
                    activeExposureUsdc: 0,
                },
                localPosition: null,
                policyTrail: [],
            },
        } as unknown as NodeContext;

        const result = await node.doAction(ctx);

        expect(result.status).toBe('skip');
        expect(result.reason).toBe('信号已超过最大时效 15000ms，已跳过迟到买单');
        expect(ctx.state.policyTrail).toContain('risk:signal_stale');
    });

    it('市场窗口已结束时跳过迟到买单', async () => {
        const node = new RiskGuardNode();
        const ctx = {
            ...buildTestContext(),
            now: () => 1774713001000,
            state: {
                sourceEvent: {
                    action: 'buy',
                    timestamp: 1774712999000,
                    eventSlug: 'eth-updown-5m-1774712700',
                    slug: 'eth-updown-5m-1774712700',
                },
                portfolio: {
                    openPositionCount: 0,
                    activeExposureUsdc: 0,
                },
                localPosition: null,
                policyTrail: [],
            },
        } as unknown as NodeContext;

        const result = await node.doAction(ctx);

        expect(result.status).toBe('skip');
        expect(result.reason).toBe('市场交易窗口已结束，已跳过迟到买单');
        expect(ctx.state.policyTrail).toContain('risk:market_window_closed');
    });
});

describe('buildCopyTradeDispatchItems', () => {
    it('会按同资产同价格窗口聚合 fixed_amount BUY', () => {
        const baseTs = 1_700_000_000_000;
        const items = buildCopyTradeDispatchItems({
            strategyKind: 'fixed_amount',
            mergeWindowMs: 1000,
            events: [
                {
                    _id: '1',
                    sourceWallet: 'source',
                    activityKey: 'buy-1',
                    timestamp: baseTs,
                    type: 'TRADE',
                    side: 'BUY',
                    action: 'buy',
                    transactionHash: 'hash-1',
                    conditionId: 'condition-1',
                    asset: 'asset-1',
                    outcome: 'Yes',
                    outcomeIndex: 0,
                    title: 'market-1',
                    slug: 'market-1',
                    eventSlug: 'event-1',
                    price: 0.54,
                    size: 1,
                    usdcSize: 1,
                    executionIntent: 'EXECUTE',
                    raw: {},
                },
                {
                    _id: '2',
                    sourceWallet: 'source',
                    activityKey: 'buy-2',
                    timestamp: baseTs + 100,
                    type: 'TRADE',
                    side: 'BUY',
                    action: 'buy',
                    transactionHash: 'hash-2',
                    conditionId: 'condition-1',
                    asset: 'asset-1',
                    outcome: 'Yes',
                    outcomeIndex: 0,
                    title: 'market-1',
                    slug: 'market-1',
                    eventSlug: 'event-1',
                    price: 0.54,
                    size: 2,
                    usdcSize: 1,
                    executionIntent: 'EXECUTE',
                    raw: {},
                },
                {
                    _id: '3',
                    sourceWallet: 'source',
                    activityKey: 'buy-3',
                    timestamp: baseTs + 150,
                    type: 'TRADE',
                    side: 'BUY',
                    action: 'buy',
                    transactionHash: 'hash-3',
                    conditionId: 'condition-1',
                    asset: 'asset-1',
                    outcome: 'Yes',
                    outcomeIndex: 0,
                    title: 'market-1',
                    slug: 'market-1',
                    eventSlug: 'event-1',
                    price: 0.53,
                    size: 3,
                    usdcSize: 2,
                    executionIntent: 'EXECUTE',
                    raw: {},
                },
                {
                    _id: '4',
                    sourceWallet: 'source',
                    activityKey: 'buy-4',
                    timestamp: baseTs + 200,
                    type: 'TRADE',
                    side: 'BUY',
                    action: 'buy',
                    transactionHash: 'hash-4',
                    conditionId: 'condition-1',
                    asset: 'asset-1',
                    outcome: 'Yes',
                    outcomeIndex: 0,
                    title: 'market-1',
                    slug: 'market-1',
                    eventSlug: 'event-1',
                    price: 0.54,
                    size: 1,
                    usdcSize: 1,
                    executionIntent: 'EXECUTE',
                    raw: {},
                },
            ] as never,
        });

        expect(items).toHaveLength(3);
        expect(items[0]?.aggregated).toBe(true);
        expect(items[0]?.sourceEvents).toHaveLength(2);
        expect(items[1]?.aggregated).toBe(false);
        expect(items[2]?.aggregated).toBe(false);
    });
});
