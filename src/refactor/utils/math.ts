export const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const clampPositive = (value: number, ceiling: number) =>
    Math.max(Math.min(value, ceiling), 0);
