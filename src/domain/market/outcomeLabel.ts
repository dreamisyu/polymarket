export const normalizeOutcomeLabel = (value: string) =>
    String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
