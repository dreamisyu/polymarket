import { loadRuntimeConfig } from '../../config/runtimeConfig';
import { createLogger } from '../../utils/logger';
import type { RefactorRuntime } from './contracts';
import { createRefactorStores } from '../db/repositories';
import { PolymarketMonitorGateway } from '../monitor/polymarketMonitorGateway';
import { LiveSettlementGateway } from '../settlement/liveSettlementGateway';
import { PaperSettlementGateway } from '../settlement/paperSettlementGateway';
import { createLiveClobClient, createPublicClobClient } from '../polymarket/clobClient';
import { LiveTradingGateway } from '../trading/liveTradingGateway';
import { PaperTradingGateway } from '../trading/paperTradingGateway';

export const createRefactorRuntime = async (
    config = loadRuntimeConfig()
): Promise<RefactorRuntime> => {
    const logger = createLogger(`${config.runMode}:${config.strategyKind}`);
    const stores = createRefactorStores(config);
    const monitor = new PolymarketMonitorGateway({ config, logger });

    if (config.runMode === 'paper') {
        if (!stores.ledger) {
            throw new Error('模拟模式缺少账本存储');
        }

        const publicClobClient = createPublicClobClient(config);
        const trading = new PaperTradingGateway({
            config,
            logger,
            ledgerStore: stores.ledger,
            clobClient: publicClobClient,
        });
        const settlement = new PaperSettlementGateway({
            config,
            settlementTasks: stores.settlementTasks,
            ledgerStore: stores.ledger,
        });

        return {
            config,
            logger,
            stores,
            gateways: {
                monitor,
                trading,
                settlement,
            },
        };
    }

    const clobClient = await createLiveClobClient(config);
    const trading = new LiveTradingGateway({
        config,
        logger,
        clobClient,
    });
    const settlement = new LiveSettlementGateway({
        config,
        logger,
        sourceEvents: stores.sourceEvents,
        settlementTasks: stores.settlementTasks,
    });

    return {
        config,
        logger,
        stores,
        gateways: {
            monitor,
            trading,
            settlement,
        },
    };
};
