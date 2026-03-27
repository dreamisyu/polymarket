export interface SourceActivityRecord {
    activityKey?: string;
    sourceActivityKeys?: string[];
    sourceTransactionHashes?: string[];
    sourceTradeCount?: number;
    sourceStartedAt?: number;
    sourceEndedAt?: number;
    proxyWallet?: string;
    timestamp: number;
    conditionId?: string;
    type?: string;
    size?: number;
    usdcSize?: number;
    transactionHash?: string;
    price?: number;
    asset?: string;
    side?: string;
    outcomeIndex?: number;
    title?: string;
    slug?: string;
    eventSlug?: string;
    outcome?: string;
    executionIntent?: 'EXECUTE' | 'SYNC_ONLY';
    sourceBalanceAfterTrade?: number;
    sourceBalanceBeforeTrade?: number;
    sourcePositionSizeAfterTrade?: number;
    sourcePositionSizeBeforeTrade?: number;
    sourcePositionPriceAfterTrade?: number;
    sourceConditionMergeableSizeAfterTrade?: number;
    sourceConditionMergeableSizeBeforeTrade?: number;
    sourceSnapshotCapturedAt?: number;
    snapshotStatus?: 'COMPLETE' | 'PARTIAL' | 'STALE';
    sourceSnapshotReason?: string;
}

export interface UserPositionRecord {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice?: number;
    currentValue?: number;
    realizedPnl?: number;
    curPrice?: number;
    redeemable?: boolean;
    mergeable?: boolean;
    title?: string;
    slug?: string;
    eventSlug?: string;
    outcome?: string;
    outcomeIndex?: number;
}

export interface MarketTokenRecord {
    outcome?: string;
    winner?: boolean;
    price?: number | string;
}

export interface GammaMarketRecord {
    conditionId?: string;
    slug?: string;
    question?: string;
    closed?: boolean;
    acceptingOrders?: boolean;
    active?: boolean;
    archived?: boolean;
    umaResolutionStatus?: string | null;
    outcomes?: string | string[] | null;
    outcomePrices?: string | string[] | null;
    tokens?: MarketTokenRecord[];
}
