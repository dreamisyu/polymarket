import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

const projectRoot = resolve(process.cwd());

const resolveEnvFilePath = () => {
    const candidates = Array.from(
        new Set([resolve(process.cwd(), '.env'), resolve(projectRoot, '.env')])
    );

    return candidates.find((candidate) => existsSync(candidate)) || resolve(projectRoot, '.env');
};

let cachedEnvFilePath: string | null = null;

export const loadEnvFile = () => {
    if (cachedEnvFilePath) {
        return cachedEnvFilePath;
    }

    const envFilePath = resolveEnvFilePath();
    dotenv.config({ path: envFilePath });
    cachedEnvFilePath = envFilePath;
    return envFilePath;
};

export const resetEnvFileCache = () => {
    cachedEnvFilePath = null;
};
