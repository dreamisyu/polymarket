import { afterEach, describe, expect, it } from '@jest/globals';
import { loadAppConfig, resetAppConfigCache } from '@config/appConfig';
import { resetEnvFileCache } from '@config/loadEnv';

const baseEnv = {
    NODE_ENV: 'test',
    RUN_MODE: 'paper',
    STRATEGY_KIND: 'fixed_amount',
    SOURCE_WALLET: '0xsource',
    TARGET_WALLET: '0xtarget',
    MONGO_URI: 'mongodb://localhost/test',
};

const managedEnvKeys = [...Object.keys(baseEnv), 'PROPORTIONAL_COPY_RATIO'] as const;
const originalEnv = Object.fromEntries(
    managedEnvKeys.map((key) => [key, process.env[key]])
) as Record<(typeof managedEnvKeys)[number], string | undefined>;

const withEnv = (overrides: Record<string, string | undefined> = {}) => {
    for (const [key, value] of Object.entries({
        ...baseEnv,
        ...overrides,
    })) {
        if (value === undefined) {
            delete process.env[key];
            continue;
        }

        process.env[key] = value;
    }
};

describe('loadAppConfig', () => {
    afterEach(() => {
        resetAppConfigCache();
        resetEnvFileCache();
        for (const key of managedEnvKeys) {
            const originalValue = originalEnv[key];
            if (originalValue === undefined) {
                delete process.env[key];
                continue;
            }

            process.env[key] = originalValue;
        }
    });

    it('mirror 策略可直接加载配置', () => {
        withEnv({
            STRATEGY_KIND: 'mirror',
        });

        const config = loadAppConfig();

        expect(config.strategyKind).toBe('mirror');
        expect(config.scopeKey).toBe('0xsource:0xtarget:paper:mirror');
    });

    it('proportional 策略缺少比例时会校验失败', () => {
        withEnv({
            STRATEGY_KIND: 'proportional',
            PROPORTIONAL_COPY_RATIO: undefined,
        });

        expect(() => loadAppConfig()).toThrow('proportional 策略缺少 PROPORTIONAL_COPY_RATIO');
    });

    it('proportional 策略要求比例必须为正数', () => {
        withEnv({
            STRATEGY_KIND: 'proportional',
            PROPORTIONAL_COPY_RATIO: '0',
        });

        expect(() => loadAppConfig()).toThrow('PROPORTIONAL_COPY_RATIO 必须是正数');
    });
});
