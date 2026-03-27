export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
