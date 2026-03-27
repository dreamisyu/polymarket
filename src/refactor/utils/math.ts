export const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeSize = (value: number, epsilon = 1e-8) =>
    Math.abs(value) < epsilon ? 0 : value;
