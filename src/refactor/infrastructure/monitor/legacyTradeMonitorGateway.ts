import tradeMonitor from '../../../services/tradeMonitor';
import createLogger from '../../../utils/logger';
import type { SourceTradeEvent } from '../../domain/types';
import { mapSourceActivity } from '../../mapper/sourceActivityMapper';
import type { MonitorGateway } from '../runtime/contracts';

const logger = createLogger('refactor:monitor');

export class LegacyTradeMonitorGateway implements MonitorGateway {
    async start(onEvents: (events: SourceTradeEvent[]) => Promise<void>) {
        await tradeMonitor({
            onSourceTradesSynced: (trades) => {
                const mappedTrades = trades.map(mapSourceActivity);
                void onEvents(mappedTrades).catch((error) => {
                    logger.error('监控回调落库失败', error);
                });
            },
        });
    }
}
