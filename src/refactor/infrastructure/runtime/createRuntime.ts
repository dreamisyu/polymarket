import createLogger from '../../../utils/logger';
import createClobClient from '../../../utils/createClobClient';
import createPublicClobClient from '../../../utils/createPublicClobClient';
import ClobMarketStream from '../../../services/clobMarketStream';
import ClobUserStream from '../../../services/clobUserStream';
import { refactorConfig } from '../../config/runtimeConfig';
import type { RefactorRuntime } from './contracts';
import { createRefactorStores } from '../db/repositories';
import { LegacyTradeMonitorGateway } from '../monitor/legacyTradeMonitorGateway';
import { LiveSettlementGateway } from '../settlement/liveSettlementGateway';
import { PaperSettlementGateway } from '../settlement/paperSettlementGateway';
import { LiveTradingGateway } from '../trading/liveTradingGateway';
import { PaperTradingGateway } from '../trading/paperTradingGateway';

export const createRefactorRuntime = async (): Promise<RefactorRuntime> => {
    const config = refactorConfig;
    const logger = createLogger(`refactor:${config.runMode}:${config.strategyKind}`);
    const stores = createRefactorStores(config);
    const monitor = new LegacyTradeMonitorGateway();

    if (config.runMode === 'paper') {
        if (!stores.ledger) {
            throw new Error('模拟模式缺少账本存储');
        }

        const publicClobClient = createPublicClobClient();
        const marketStream = new ClobMarketStream((assetId) => publicClobClient.getOrderBook(assetId));
        const trading = new PaperTradingGateway({
            config,
            logger,
            ledgerStore: stores.ledger,
            marketStream,
        });
        const settlement = new PaperSettlementGateway({
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

    const clobClient = await createClobClient();
    const marketStream = new ClobMarketStream((assetId) => clobClient.getOrderBook(assetId));
    const userStream = clobClient.creds ? new ClobUserStream(clobClient.creds) : null;
    const trading = new LiveTradingGateway({
        config,
        logger,
        clobClient,
        marketStream,
        userStream,
    });
    const settlement = new LiveSettlementGateway();

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
