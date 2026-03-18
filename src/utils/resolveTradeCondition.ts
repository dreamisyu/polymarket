const resolveTradeCondition = (
    tradeSide: string,
    myPosition?: { size?: number } | null,
    userPosition?: { size?: number } | null
) => {
    const normalizedSide = tradeSide.toUpperCase();
    const hasMyPosition = Boolean(myPosition && (myPosition.size || 0) > 0);
    const hasUserPosition = Boolean(userPosition && (userPosition.size || 0) > 0);

    if (normalizedSide === 'BUY') {
        return 'buy';
    }

    if (normalizedSide === 'SELL') {
        return 'sell';
    }

    if (normalizedSide === 'MERGE' || (hasMyPosition && !hasUserPosition)) {
        return 'merge';
    }

    return normalizedSide.toLowerCase();
};

export default resolveTradeCondition;
