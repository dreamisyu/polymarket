import LiveSettlementReclaimer from '../../../services/liveSettlementReclaimer';
import type { SettlementGateway } from '../runtime/contracts';

export class LiveSettlementGateway implements SettlementGateway {
    private readonly reclaimer = new LiveSettlementReclaimer();

    async runDue() {
        await this.reclaimer.runDue();
    }
}
