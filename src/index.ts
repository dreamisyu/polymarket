import connectDB from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor from './services/tradeExecutor';
import tradeMonitor from './services/tradeMonitor';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;
export const main = async () => {
    try {
        await connectDB();

        console.log(`Target User Wallet address is: ${USER_ADDRESS}`);
        console.log(`My Wallet address is: ${PROXY_WALLET}`);

        const clobClient = await createClobClient();
        
        tradeMonitor().catch((error) => {
            console.error('Trade Monitor error:', error);
            process.exit(1);
        });
        
        tradeExecutor(clobClient).catch((error) => {
            console.error('Trade Executor error:', error);
            process.exit(1);
        });
    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
};

main();
