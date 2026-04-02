import type { AppConfig } from '@config/appConfig';
import DatabaseBootstrap from '@application/database/DatabaseBootstrap';
import { createLoopWorker } from '@application/worker/CreateLoopWorker';
import WorkflowCatalog from '@application/workflow/WorkflowCatalog';
import WorkflowContextFactory from '@application/workflow/WorkflowContextFactory';
import type { ApplicationRuntime } from '@infrastructure/runtime/contracts';
import type { Logger } from '@shared/logger';

const startWorker = (logger: Logger, name: string, run: () => Promise<void>) => {
    run().catch((error) => {
        logger.error({ err: error }, `${name} 已退出`);
        process.exit(1);
    });
};

export default class MainApplication {
    constructor(
        private readonly deps: {
            appConfig: AppConfig;
            appLogger: Logger;
            databaseBootstrap: DatabaseBootstrap;
            applicationRuntime: ApplicationRuntime;
            workflowCatalog: WorkflowCatalog;
            workflowContextFactory: WorkflowContextFactory;
        }
    ) {}

    async start() {
        await this.deps.databaseBootstrap.connect();

        this.deps.applicationRuntime.logger.info(
            `启动完成 mode=${this.deps.appConfig.runMode} strategy=${this.deps.appConfig.strategyKind} self=${this.deps.appConfig.sourceWallet} follow=${this.deps.appConfig.targetWallet}`
        );

        const workers = [
            createLoopWorker({
                name: '监控分发工作流',
                intervalMs: this.deps.appConfig.monitorIntervalMs,
                logger: this.deps.applicationRuntime.logger,
                runOnce: async () => {
                    await this.deps.applicationRuntime.workflowEngine.run(
                        this.deps.workflowContextFactory.createMonitorContext(),
                        this.deps.workflowCatalog.monitor
                    );
                },
            }),
            createLoopWorker({
                name: '结算工作流',
                intervalMs: this.deps.appConfig.settlementIntervalMs,
                logger: this.deps.applicationRuntime.logger,
                runOnce: async () => {
                    await this.deps.applicationRuntime.workflowEngine.run(
                        this.deps.workflowContextFactory.createSettlementContext(),
                        this.deps.workflowCatalog.settlement
                    );
                },
            }),
        ];

        for (const worker of workers) {
            startWorker(this.deps.appLogger, worker.name, worker.run);
        }
    }
}
