import { main } from './app/main';
import { createLogger } from './utils/logger';

const logger = createLogger('app');

void main().catch((error) => {
    logger.error('启动失败', error);
    process.exit(1);
});
