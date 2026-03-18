import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import createPublicClobClient from '../utils/createPublicClobClient';
import ClobMarketStream from './clobMarketStream';
import ClobUserStream from './clobUserStream';
import tradeExecutor from './tradeExecutor';
import paperTradeExecutor from './paperTradeExecutor';

interface ExecutorRuntime {
    label: string;
    name: string;
    run: () => Promise<void>;
}

const createExecutor = async (): Promise<ExecutorRuntime> => {
    if (ENV.EXECUTION_MODE === 'trace') {
        const publicClobClient = createPublicClobClient();
        const marketStream = new ClobMarketStream((assetId) =>
            publicClobClient.getOrderBook(assetId)
        );
        return {
            label: ENV.TRACE_LABEL,
            name: '模拟执行器',
            run: () => paperTradeExecutor(marketStream),
        };
    }

    const clobClient = await createClobClient();
    const marketStream = new ClobMarketStream((assetId) => clobClient.getOrderBook(assetId));
    const userStream = clobClient.creds ? new ClobUserStream(clobClient.creds) : null;

    return {
        label: ENV.PROXY_WALLET,
        name: '实盘执行器',
        run: () => tradeExecutor(clobClient, marketStream, userStream),
    };
};

export default createExecutor;
