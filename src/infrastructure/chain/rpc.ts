export const rpcRequestTimeoutMs = 10_000;

export const withRpcTimeout = async <T>(
    task: Promise<T>,
    label: string,
    timeoutMs = rpcRequestTimeoutMs
) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race<T>([
            task,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`${label} 超时（${timeoutMs}ms）`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
};
