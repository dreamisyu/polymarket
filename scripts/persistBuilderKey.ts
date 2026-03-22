import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import createClobClient from '../src/utils/createClobClient';

const upsertEnvValue = (content: string, key: string, value: string) => {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(content)) {
        return content.replace(pattern, line);
    }

    const normalized = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
    return `${normalized}${line}\n`;
};

const persistIntoEnvFile = (filePath: string, builderKey: Record<string, string>) => {
    const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    let next = content;
    next = upsertEnvValue(next, 'POLYMARKET_RELAYER_TX_TYPE', 'PROXY');
    next = upsertEnvValue(next, 'POLY_BUILDER_API_KEY', builderKey.key);
    next = upsertEnvValue(next, 'POLY_BUILDER_SECRET', builderKey.secret);
    next = upsertEnvValue(next, 'POLY_BUILDER_PASSPHRASE', builderKey.passphrase);
    writeFileSync(filePath, next, 'utf8');
};

const main = async () => {
    const clobClient = await createClobClient();
    const builderKey = await clobClient.createBuilderApiKey();
    if (!builderKey?.key || !builderKey?.secret || !builderKey?.passphrase) {
        throw new Error('builder key 返回值不完整，无法固化到环境变量');
    }

    const files = [resolve('.env'), resolve('.env.live')];
    for (const filePath of files) {
        persistIntoEnvFile(filePath, builderKey);
    }

    console.log(
        JSON.stringify({
            persistedFiles: files,
            relayerTxType: 'PROXY',
            builderKeyPersisted: true,
        })
    );
};

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
