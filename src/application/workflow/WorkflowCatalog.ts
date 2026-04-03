import {
    NodeChainBuilder,
    type NodeWorkflowDefinition,
} from '@domain/nodes/kernel/NodeChainBuilder';
import { buildStrategyResult, type StrategyBuildResult } from '@domain/strategy/types';
import StrategyRegistry from '@application/workflow/StrategyRegistry';

export default class WorkflowCatalog {
    readonly strategy: StrategyBuildResult;
    readonly monitor: NodeWorkflowDefinition;
    readonly settlement: NodeWorkflowDefinition;

    constructor(private readonly deps: { strategyRegistry: StrategyRegistry }) {
        this.strategy = buildStrategyResult(deps.strategyRegistry.activeStrategy);
        this.monitor = new NodeChainBuilder()
            .append('monitor.fetch')
            .append('monitor.persist')
            .append('monitor.aggregate')
            .append('monitor.dispatch')
            .build();
        this.settlement = new NodeChainBuilder().append('settlement.sweep').build();
    }
}
