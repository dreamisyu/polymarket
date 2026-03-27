import { loadRuntimeConfig } from '../../config/runtimeConfig';
import { createLogger } from '../../utils/logger';
import type { Runtime } from './contracts';
import { createStores } from '../db/repositories';
import { PolymarketMonitorGateway } from '../monitor/polymarketMonitorGateway';
import { LiveSettlementGateway } from '../settlement/liveSettlementGateway';
import { PaperSettlementGateway } from '../settlement/paperSettlementGateway';
import { createLiveClobClient, createPublicClobClient } from '../polymarket/clobClient';
import { PolymarketMarketBookFeed } from '../polymarket/marketBookFeed';
import { PolymarketUserExecutionFeed } from '../polymarket/userExecutionFeed';
import { LiveTradingGateway } from '../trading/liveTradingGateway';
import { PaperTradingGateway } from '../trading/paperTradingGateway';

export const createRuntime = async (
    config = loadRuntimeConfig()
): Promise<Runtime> => {
    const logger = createLogger(`${config.runMode}:${config.strategyKind}`);
    const stores = createStores(config);
    const monitor = new PolymarketMonitorGateway({ config, logger });

    if (config.runMode === 'paper') {
        if (!stores.ledger) {
            throw new Error('模拟模式缺少账本存储');
        }

        const publicClobClient = createPublicClobClient(config);
        const marketFeed = new PolymarketMarketBookFeed({
            config,
            logger,
            fetchBook: (assetId) => publicClobClient.getOrderBook(assetId),
        });
        const trading = new PaperTradingGateway({
            config,
            logger,
            ledgerStore: stores.ledger,
            marketFeed,
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

    const clobSession = await createLiveClobClient(config);
    const marketFeed = new PolymarketMarketBookFeed({
        config,
        logger,
        fetchBook: (assetId) => clobSession.client.getOrderBook(assetId),
    });
    const userExecutionFeed = new PolymarketUserExecutionFeed({
        config,
        logger,
        creds: clobSession.creds,
    });
    const trading = new LiveTradingGateway({
        config,
        logger,
        clobClient: clobSession.client,
        marketFeed,
        userExecutionFeed,
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
