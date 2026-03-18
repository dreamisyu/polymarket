import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import tradeExecutor from './tradeExecutor';
import paperTradeExecutor from './paperTradeExecutor';

interface ExecutorRuntime {
    label: string;
    run: () => Promise<void>;
}

const createExecutor = async (): Promise<ExecutorRuntime> => {
    if (ENV.EXECUTION_MODE === 'trace') {
        return {
            label: ENV.TRACE_LABEL,
            run: paperTradeExecutor,
        };
    }

    const clobClient = await createClobClient();

    return {
        label: ENV.PROXY_WALLET,
        run: () => tradeExecutor(clobClient),
    };
};

export default createExecutor;
