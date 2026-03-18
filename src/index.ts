import connectDB from './config/db';
import { ENV } from './config/env';
import tradeMonitor from './services/tradeMonitor';
import createExecutor from './services/createExecutor';

const USER_ADDRESS = ENV.USER_ADDRESS;
export const main = async () => {
    try {
        await connectDB();

        console.log(`Target User Wallet address is: ${USER_ADDRESS}`);
        const executor = await createExecutor();
        console.log(`Execution mode is: ${ENV.EXECUTION_MODE}`);
        console.log(`Execution target is: ${executor.label}`);

        tradeMonitor().catch((error) => {
            console.error('Trade Monitor error:', error);
            process.exit(1);
        });

        executor.run().catch((error) => {
            console.error('Trade Executor error:', error);
            process.exit(1);
        });
    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
};

main();
