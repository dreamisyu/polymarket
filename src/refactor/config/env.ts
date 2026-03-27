import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../../..');
const envPathCandidates = Array.from(
    new Set([resolve(process.cwd(), '.env'), resolve(projectRoot, '.env')])
);
const envFilePath = envPathCandidates.find((candidate) => existsSync(candidate)) || resolve(projectRoot, '.env');

dotenv.config({ path: envFilePath });

const readEnv = (name: string) => {
    const value = process.env[name];
    return typeof value === 'string' ? value.trim() : '';
};

const requireEnv = (name: string) => {
    const value = readEnv(name);
    if (!value) {
        throw new Error(`${name} 未配置（加载路径 ${envFilePath}）`);
    }

    return value;
};

const toPositiveNumber = (name: string, fallback?: number) => {
    const raw = readEnv(name);
    if (!raw && fallback !== undefined) {
        return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} 必须是正数`);
    }

    return parsed;
};

const toNonNegativeNumber = (name: string, fallback?: number) => {
    const raw = readEnv(name);
    if (!raw && fallback !== undefined) {
        return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${name} 必须是非负数`);
    }

    return parsed;
};

const toBoolean = (name: string, fallback: boolean) => {
    const raw = readEnv(name);
    if (!raw) {
        return fallback;
    }

    return raw === '1' || raw.toLowerCase() === 'true';
};

const toChoice = <T extends string>(
    name: string,
    values: readonly T[],
    fallback?: T
): T => {
    const raw = readEnv(name);
    const normalized = raw || fallback || '';
    if (values.includes(normalized as T)) {
        return normalized as T;
    }

    throw new Error(`${name} 必须是 ${values.join(', ')}`);
};

export const env = {
    envFilePath,
    readEnv,
    requireEnv,
    toPositiveNumber,
    toNonNegativeNumber,
    toBoolean,
    toChoice,
};
