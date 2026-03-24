import { describe, expect, it, jest } from '@jest/globals';
import { BaseNode } from '../kernel/BaseNode';
import { NodeChainBuilder } from '../kernel/NodeChainBuilder';
import type { NodeContext } from '../kernel/NodeContext';
import type { NodeResult } from '../kernel/NodeResult';
import { NodeRegistry } from '../kernel/NodeRegistry';
import { NodeWorkflowEngine } from '../kernel/NodeWorkflowEngine';

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
            scopeKey: 'scope',
            traceId: 'trace',
            traceLabel: 'trace',
            monitorLoopIntervalMs: 1000,
            strategyLoopIntervalMs: 1000,
            settlementLoopIntervalMs: 1000,
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
            liveConfirmTimeoutMs: 1000,
            liveReconcileAfterTimeoutMs: 1000,
            traceInitialBalance: 1000,
        },
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        },
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
});
