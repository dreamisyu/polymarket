import { ApiKeyCreds, Chain, ClobClient, SignatureType } from '@polymarket/clob-client';
import { Wallet, type TypedDataDomain, type TypedDataField } from 'ethers';
import type { ClobSignatureType, RuntimeConfig } from '@config/runtimeConfig';

export interface LiveClobSession {
    client: ClobClient;
    creds: ApiKeyCreds;
}

const isValidApiKeyCreds = (value: unknown): value is ApiKeyCreds => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const payload = value as Record<string, unknown>;
    return (
        typeof payload.key === 'string' &&
        payload.key.length > 0 &&
        typeof payload.secret === 'string' &&
        payload.secret.length > 0 &&
        typeof payload.passphrase === 'string' &&
        payload.passphrase.length > 0
    );
};

const createSigner = (privateKey: string) => {
    const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new Wallet(normalizedPrivateKey);
    type TypedDataTypes = Record<string, Array<TypedDataField>>;
    type TypedDataValue = Record<string, unknown>;

    return {
        _signTypedData: (domain: TypedDataDomain, types: TypedDataTypes, value: TypedDataValue) =>
            wallet.signTypedData(domain, types, value),
        getAddress: async () => wallet.address,
    };
};

export const createPublicClobClient = (config: Pick<RuntimeConfig, 'clobHttpUrl'>) =>
    new ClobClient(
        config.clobHttpUrl,
        Chain.POLYGON,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true
    );

const resolveSignatureType = (signatureType: ClobSignatureType): SignatureType => {
    switch (signatureType) {
        case 'EOA':
            return SignatureType.EOA;
        case 'PROXY':
            return SignatureType.POLY_PROXY;
        case 'SAFE':
            return SignatureType.POLY_GNOSIS_SAFE;
        default:
            throw new Error(`不支持的 CLOB 签名类型: ${signatureType satisfies never}`);
    }
};

export const createLiveClobClient = async (
    config: Pick<RuntimeConfig, 'clobHttpUrl' | 'proxyWallet' | 'privateKey' | 'clobSignatureType'>
): Promise<LiveClobSession> => {
    if (!config.privateKey) {
        throw new Error('live 模式缺少 PRIVATE_KEY');
    }

    const signatureType = resolveSignatureType(config.clobSignatureType);
    const funderAddress =
        signatureType === SignatureType.EOA ? undefined : config.proxyWallet || undefined;
    if (signatureType !== SignatureType.EOA && !funderAddress) {
        throw new Error('代理钱包账户缺少 PROXY_WALLET');
    }

    const signer = createSigner(config.privateKey);
    const bootstrapClient = new ClobClient(
        config.clobHttpUrl,
        Chain.POLYGON,
        signer,
        undefined,
        signatureType,
        funderAddress,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true
    );
    const derivedCreds = await bootstrapClient.deriveApiKey();
    const rawCreds = isValidApiKeyCreds(derivedCreds)
        ? derivedCreds
        : await bootstrapClient.createApiKey();
    if (!isValidApiKeyCreds(rawCreds)) {
        throw new Error('创建或派生 CLOB API Key 失败');
    }

    return {
        client: new ClobClient(
            config.clobHttpUrl,
            Chain.POLYGON,
            signer,
            rawCreds,
            signatureType,
            funderAddress,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true
        ),
        creds: rawCreds,
    };
};
