import { describe, expect, it, jest } from '@jest/globals';
import { BaseNode } from '../domain/nodes/kernel/BaseNode';
import { NodeChainBuilder } from '../domain/nodes/kernel/NodeChainBuilder';
import type { NodeContext } from '../domain/nodes/kernel/NodeContext';
import type { NodeResult } from '../domain/nodes/kernel/NodeResult';
import { NodeRegistry } from '../domain/nodes/kernel/NodeRegistry';
import { NodeWorkflowEngine } from '../domain/nodes/kernel/NodeWorkflowEngine';
import { DispatchCopyTradeNode } from '../domain/nodes/monitor/DispatchCopyTradeNode';
import { buildCopyTradeDispatchItems } from '../utils/copytradeDispatch';

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
        config: {
            runMode: 'paper',
            strategyKind: 'fixed_amount',
            sourceWallet: 'source',
            targetWallet: 'target',
            mongoUri: 'mongodb://localhost/test',
            scopeKey: 'scope',
            monitorIntervalMs: 1000,
            monitorInitialLookbackMs: 1000,
            monitorOverlapMs: 1000,
            activitySyncLimit: 100,
            activityAdjacentMergeWindowMs: 1000,
            snapshotStaleAfterMs: 1000,
            settlementIntervalMs: 1000,
            fixedTradeAmountUsdc: 1,
            maxOpenPositions: 4,
            maxActiveExposureUsdc: 10,
            signalMarketScope: 'all',
            signalWeakThresholdUsdc: 1,
            signalNormalThresholdUsdc: 2,
            signalStrongThresholdUsdc: 3,
            signalWeakTicketUsdc: 1,
            signalNormalTicketUsdc: 2,
            signalStrongTicketUsdc: 3,
            maxRetryCount: 3,
            retryBackoffMs: 1000,
            copytradeDispatchConcurrency: 2,
            clobHttpUrl: 'https://clob.polymarket.com',
            clobWsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
            userWsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
            dataApiUrl: 'https://data-api.polymarket.com',
            gammaApiUrl: 'https://gamma-api.polymarket.com',
            rpcUrl: 'https://polygon.drpc.org',
            settlementMaxTasksPerRun: 8,
            marketWsReconnectMs: 1000,
            userWsReconnectMs: 1000,
            wsHeartbeatMs: 10_000,
            marketBookStaleMs: 2500,
            marketWsBootstrapWaitMs: 750,
            orderConfirmationTimeoutMs: 1000,
            orderConfirmationPollMs: 1000,
            orderConfirmationBlocks: 1,
            liveConfirmTimeoutMs: 1000,
            liveReconcileAfterTimeoutMs: 1000,
            liveOrderMinIntervalMs: 100,
            maxSlippageBps: 100,
            maxOrderUsdc: 10,
            buyDustResidualMode: 'trim',
            relayerTxType: 'SAFE',
            usdcContractAddress: '0x0000000000000000000000000000000000000001',
            ctfContractAddress: '0x0000000000000000000000000000000000000002',
            autoRedeemEnabled: false,
            autoRedeemIntervalMs: 1000,
            autoRedeemMaxConditionsPerRun: 1,
            paperInitialBalance: 1000,
        },
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        } as never,
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
            engine: { runDetached } as unknown as NodeWorkflowEngine,
            workflow: { headNodeId: 'copytrade.context', transitions: new Map() },
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
