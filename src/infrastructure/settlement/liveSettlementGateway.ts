import type { RuntimeConfig } from '@config/runtimeConfig';
import type { SettlementRedeemRequest, SettlementRedeemResult } from '@domain';
import { confirmTransactionHashes } from '@infrastructure/chain/confirm';
import { submitRedeemPositions } from '@infrastructure/chain/ctf';
import type { LoggerLike, SettlementGateway } from '@infrastructure/runtime/contracts';

const isBytes32Hex = (value: string) => /^0x[a-fA-F0-9]{64}$/.test(value);

export class LiveSettlementGateway implements SettlementGateway {
    private readonly config: RuntimeConfig;
    private readonly logger: LoggerLike;

    constructor(params: { config: RuntimeConfig; logger: LoggerLike }) {
        this.config = params.config;
        this.logger = params.logger;
    }

    async executeRedeem(request: SettlementRedeemRequest): Promise<SettlementRedeemResult> {
        if (!isBytes32Hex(request.conditionId)) {
            return {
                status: 'failed',
                reason: 'conditionId 非法，无法提交 redeem',
                transactionHashes: [],
            };
        }

        if (request.indexSets.length === 0 || request.positions.length === 0) {
            return {
                status: 'failed',
                reason: '缺少可回收仓位或 outcome partition',
                transactionHashes: [],
            };
        }

        try {
            const hash = await submitRedeemPositions(
                {
                    conditionId: request.conditionId,
                    indexSets: request.indexSets,
                },
                this.config
            );
            const confirmation = await confirmTransactionHashes([hash], this.config, {
                timeoutMs: this.config.liveConfirmTimeoutMs,
            });
            if (confirmation.status === 'CONFIRMED') {
                return {
                    status: 'confirmed',
                    reason: `redeem 已确认 tx=${hash}`,
                    transactionHashes: [hash],
                    confirmedAt: confirmation.confirmedAt,
                };
            }

            return {
                status: 'retry',
                reason: confirmation.reason || 'redeem 未确认，稍后重试',
                transactionHashes: [hash],
            };
        } catch (error) {
            this.logger.error(
                { err: error },
                `提交 live redeem 失败 condition=${request.conditionId}`
            );
            return {
                status: 'retry',
                reason: (error as { message?: string })?.message || '提交 live redeem 失败',
                transactionHashes: [],
            };
        }
    }
}
