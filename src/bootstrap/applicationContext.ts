import {
    asClass,
    asFunction,
    asValue,
    createContainer,
    InjectionMode,
    type AwilixContainer,
} from 'awilix';
import MainApplication from '@application/runner/MainApplication';
import DatabaseBootstrap from '@application/database/DatabaseBootstrap';
import StrategyRegistry from '@application/workflow/StrategyRegistry';
import WorkflowCatalog from '@application/workflow/WorkflowCatalog';
import WorkflowContextFactory from '@application/workflow/WorkflowContextFactory';
import { loadAppConfig } from '@config/appConfig';
import { ActionRouterNode } from '@domain/nodes/copytrade/ActionRouterNode';
import { ExecuteTradeNode } from '@domain/nodes/copytrade/ExecuteTradeNode';
import { FixedAmountTradePlanningNode } from '@domain/nodes/copytrade/FixedAmountTradePlanningNode';
import { LoadTradingContextNode } from '@domain/nodes/copytrade/LoadTradingContextNode';
import { MergeExecuteNode } from '@domain/nodes/copytrade/MergeExecuteNode';
import { MergePlanningNode } from '@domain/nodes/copytrade/MergePlanningNode';
import { PersistExecutionNode } from '@domain/nodes/copytrade/PersistExecutionNode';
import { RedeemForwardNode } from '@domain/nodes/copytrade/RedeemForwardNode';
import { RiskGuardNode } from '@domain/nodes/copytrade/RiskGuardNode';
import {
    FixedAmountSizingNode,
    ProportionalSizingNode,
    SignalSizingNode,
} from '@domain/nodes/copytrade/SizingNodes';
import { TradePlanningNode } from '@domain/nodes/copytrade/TradePlanningNode';
import { NodeRegistry } from '@domain/nodes/kernel/NodeRegistry';
import { NodeWorkflowEngine } from '@domain/nodes/kernel/NodeWorkflowEngine';
import { DispatchCopyTradeNode } from '@domain/nodes/monitor/DispatchCopyTradeNode';
import { FetchMonitorEventsNode } from '@domain/nodes/monitor/FetchMonitorEventsNode';
import { PersistMonitorEventsNode } from '@domain/nodes/monitor/PersistMonitorEventsNode';
import { PrepareDispatchBundlesNode } from '@domain/nodes/monitor/PrepareDispatchBundlesNode';
import { SettlementSweepNode } from '@domain/nodes/settlement/SettlementSweepNode';
import { createStores } from '@infrastructure/db/repositories';
import { PolymarketMonitorGateway } from '@infrastructure/monitor/polymarketMonitorGateway';
import {
    createLiveClobClient,
    createPublicClobClient,
} from '@infrastructure/polymarket/clobClient';
import { PolymarketMarketBookFeed } from '@infrastructure/polymarket/marketBookFeed';
import { PolymarketUserExecutionFeed } from '@infrastructure/polymarket/userExecutionFeed';
import type {
    ApplicationRuntime,
    RuntimeGateways,
    RuntimeStores,
    WorkflowRuntime,
} from '@infrastructure/runtime/contracts';
import { LiveSettlementGateway } from '@infrastructure/settlement/liveSettlementGateway';
import { PaperSettlementGateway } from '@infrastructure/settlement/paperSettlementGateway';
import { LiveTradingGateway } from '@infrastructure/trading/liveTradingGateway';
import { PaperTradingGateway } from '@infrastructure/trading/paperTradingGateway';
import { createLoggerFactory, type LoggerFactory } from '@shared/logger';

export interface ApplicationContext {
    container: AwilixContainer;
    app: MainApplication;
}

const buildRuntimeServices = async (loggerFactory: LoggerFactory) => {
    const appConfig = loadAppConfig();
    const stores = createStores(appConfig);
    const monitor = new PolymarketMonitorGateway({
        config: appConfig,
        logger: loggerFactory.createLogger('monitor'),
    });

    if (appConfig.runMode === 'paper') {
        if (!stores.ledger) {
            throw new Error('模拟模式缺少账本存储');
        }

        const publicClobClient = createPublicClobClient(appConfig);
        const marketFeed = new PolymarketMarketBookFeed({
            config: appConfig,
            logger: loggerFactory.createLogger('market-book'),
            fetchBook: (assetId) => publicClobClient.getOrderBook(assetId),
        });
        const trading = new PaperTradingGateway({
            config: appConfig,
            logger: loggerFactory.createLogger('paper-trading'),
            ledgerStore: stores.ledger,
            marketFeed,
        });
        const settlement = new PaperSettlementGateway({
            config: appConfig,
        });

        return {
            stores,
            gateways: {
                monitor,
                trading,
                settlement,
            } satisfies RuntimeGateways,
        } satisfies { stores: RuntimeStores; gateways: RuntimeGateways };
    }

    const clobSession = await createLiveClobClient(appConfig);
    const marketFeed = new PolymarketMarketBookFeed({
        config: appConfig,
        logger: loggerFactory.createLogger('market-book'),
        fetchBook: (assetId) => clobSession.client.getOrderBook(assetId),
    });
    const userExecutionFeed = new PolymarketUserExecutionFeed({
        config: appConfig,
        logger: loggerFactory.createLogger('user-execution-feed'),
        creds: clobSession.creds,
    });
    const trading = new LiveTradingGateway({
        config: appConfig,
        logger: loggerFactory.createLogger('live-trading'),
        clobClient: clobSession.client,
        marketFeed,
        userExecutionFeed,
        persistence: {
            sourceEvents: stores.sourceEvents,
            executions: stores.executions,
            settlementTasks: stores.settlementTasks,
        },
    });
    const settlement = new LiveSettlementGateway({
        config: appConfig,
        logger: loggerFactory.createLogger('live-settlement'),
    });

    return {
        stores,
        gateways: {
            monitor,
            trading,
            settlement,
        } satisfies RuntimeGateways,
    } satisfies { stores: RuntimeStores; gateways: RuntimeGateways };
};

const registerNodeModules = (container: AwilixContainer) => {
    container.register({
        actionRouterNode: asClass(ActionRouterNode).singleton(),
        executeTradeNode: asClass(ExecuteTradeNode).singleton(),
        fixedAmountTradePlanningNode: asClass(FixedAmountTradePlanningNode).singleton(),
        loadTradingContextNode: asClass(LoadTradingContextNode).singleton(),
        mergeExecuteNode: asClass(MergeExecuteNode).singleton(),
        mergePlanningNode: asClass(MergePlanningNode).singleton(),
        persistExecutionNode: asClass(PersistExecutionNode).singleton(),
        redeemForwardNode: asClass(RedeemForwardNode).singleton(),
        riskGuardNode: asClass(RiskGuardNode).singleton(),
        tradePlanningNode: asClass(TradePlanningNode).singleton(),
        fixedAmountSizingNode: asClass(FixedAmountSizingNode).singleton(),
        proportionalSizingNode: asClass(ProportionalSizingNode).singleton(),
        signalSizingNode: asClass(SignalSizingNode).singleton(),
        fetchMonitorEventsNode: asClass(FetchMonitorEventsNode).singleton(),
        persistMonitorEventsNode: asClass(PersistMonitorEventsNode).singleton(),
        prepareDispatchBundlesNode: asClass(PrepareDispatchBundlesNode).singleton(),
        settlementSweepNode: asClass(SettlementSweepNode).singleton(),
        dispatchCopyTradeNode: asFunction((cradle) => {
            const workflowContextFactory = cradle.workflowContextFactory as WorkflowContextFactory;
            return new DispatchCopyTradeNode({
                resolveEngine: () => cradle.workflowEngine as NodeWorkflowEngine,
                resolveWorkflow: () =>
                    (cradle.workflowCatalog as WorkflowCatalog).strategy.workflow,
                buildCopyTradeContext: (dispatchItem, parentCtx) =>
                    workflowContextFactory.createCopyTradeContext(dispatchItem, parentCtx),
            });
        }).singleton(),
    });
};

const createNodeRegistry = (container: AwilixContainer) => {
    const registry = new NodeRegistry();
    const nodeNames = [
        'actionRouterNode',
        'executeTradeNode',
        'fixedAmountTradePlanningNode',
        'loadTradingContextNode',
        'mergeExecuteNode',
        'mergePlanningNode',
        'persistExecutionNode',
        'redeemForwardNode',
        'riskGuardNode',
        'tradePlanningNode',
        'fixedAmountSizingNode',
        'proportionalSizingNode',
        'signalSizingNode',
        'fetchMonitorEventsNode',
        'persistMonitorEventsNode',
        'prepareDispatchBundlesNode',
        'dispatchCopyTradeNode',
        'settlementSweepNode',
    ] as const;

    for (const name of nodeNames) {
        registry.register(container.resolve(name));
    }

    return registry;
};

export const createApplicationContext = async (): Promise<ApplicationContext> => {
    const appConfig = loadAppConfig();
    const loggerFactory = createLoggerFactory(appConfig);
    const runtimeServices = await buildRuntimeServices(loggerFactory);
    const container = createContainer({
        injectionMode: InjectionMode.PROXY,
        strict: true,
    });

    container.register({
        appConfig: asValue(appConfig),
        loggerFactory: asValue(loggerFactory),
        appLogger: asValue(loggerFactory.createLogger('app')),
        runtimeLogger: asValue(
            loggerFactory.createLogger(`${appConfig.runMode}:${appConfig.strategyKind}`)
        ),
        stores: asValue(runtimeServices.stores),
        monitorGateway: asValue(runtimeServices.gateways.monitor),
        tradingGateway: asValue(runtimeServices.gateways.trading),
        settlementGateway: asValue(runtimeServices.gateways.settlement),
        databaseBootstrap: asClass(DatabaseBootstrap).singleton(),
        strategyRegistry: asClass(StrategyRegistry).singleton(),
        workflowCatalog: asClass(WorkflowCatalog).singleton(),
    });

    registerNodeModules(container);

    container.register({
        nodeRegistry: asFunction(() => createNodeRegistry(container)).singleton(),
        workflowEngine: asFunction(
            ({ nodeRegistry }) =>
                new NodeWorkflowEngine(nodeRegistry, {
                    detachedConcurrency: appConfig.copytradeDispatchConcurrency,
                })
        ).singleton(),
        workflowRuntime: asFunction(
            ({ runtimeLogger }) =>
                ({
                    config: appConfig,
                    logger: runtimeLogger,
                    stores: runtimeServices.stores,
                    gateways: runtimeServices.gateways,
                }) satisfies WorkflowRuntime
        ).singleton(),
        applicationRuntime: asFunction(
            ({ workflowRuntime, workflowEngine }) =>
                ({
                    ...workflowRuntime,
                    workflowEngine,
                }) satisfies ApplicationRuntime
        ).singleton(),
        workflowContextFactory: asClass(WorkflowContextFactory).singleton(),
        mainApplication: asClass(MainApplication).singleton(),
    });

    return {
        container,
        app: container.resolve<MainApplication>('mainApplication'),
    };
};
