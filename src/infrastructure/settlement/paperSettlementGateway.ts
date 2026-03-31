import type { AppConfig } from '@config/appConfig';
import type { SettlementRedeemRequest, SettlementRedeemResult } from '@domain';
import type { SettlementGateway } from '@infrastructure/runtime/contracts';

export class PaperSettlementGateway implements SettlementGateway {
    private readonly config: AppConfig;

    constructor(params: { config: AppConfig }) {
        this.config = params.config;
    }

    async executeRedeem(_request: SettlementRedeemRequest): Promise<SettlementRedeemResult> {
        return {
            status: 'confirmed',
            reason: 'paper 模式不发送链上 redeem 交易',
            transactionHashes: [],
            confirmedAt: Date.now(),
        };
    }
}
