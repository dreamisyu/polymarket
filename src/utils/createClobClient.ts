import { ApiKeyCreds, ClobClient, SignatureType } from '@polymarket/clob-client';
import { TypedDataDomain, TypedDataField, Wallet } from 'ethers';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

type TypedDataTypes = Record<string, Array<TypedDataField>>;
type TypedDataValue = Record<string, unknown>;

const resolveSignatureType = () =>
    ENV.POLYMARKET_RELAYER_TX_TYPE === 'PROXY'
        ? SignatureType.POLY_PROXY
        : SignatureType.POLY_GNOSIS_SAFE;

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

const extractApiError = (value: unknown) => {
    if (!value || typeof value !== 'object') {
        return '';
    }

    const payload = value as Record<string, unknown>;
    const status =
        typeof payload.status === 'number' && Number.isFinite(payload.status)
            ? `status=${payload.status} `
            : '';
    if (payload.error === undefined || payload.error === null) {
        return '';
    }

    return `${status}reason=${String(payload.error)}`.trim();
};

const createSigner = () => {
    const normalizedPrivateKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
    const wallet = new Wallet(normalizedPrivateKey);

    return {
        _signTypedData: (domain: TypedDataDomain, types: TypedDataTypes, value: TypedDataValue) =>
            wallet.signTypedData(domain, types, value),
        getAddress: async () => wallet.address,
    };
};

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const signer = createSigner();
    const signatureType = resolveSignatureType();
    const bootstrapClient = new ClobClient(
        CLOB_HTTP_URL,
        chainId,
        signer,
        undefined,
        signatureType,
        PROXY_WALLET
    );
    const derivedCreds = await bootstrapClient.deriveApiKey();
    const rawCreds = isValidApiKeyCreds(derivedCreds)
        ? derivedCreds
        : await bootstrapClient.createApiKey();
    if (!isValidApiKeyCreds(rawCreds)) {
        const deriveReason = extractApiError(derivedCreds);
        const createReason = extractApiError(rawCreds);
        const reason = [deriveReason, createReason].filter(Boolean).join('；');
        throw new Error(
            `创建或派生 CLOB API Key 失败：返回值缺少 key/secret/passphrase` +
                (reason ? `（${reason}）` : '') +
                '，请检查代理钱包签名类型与私钥是否匹配'
        );
    }
    const creds = rawCreds;

    return new ClobClient(CLOB_HTTP_URL, chainId, signer, creds, signatureType, PROXY_WALLET);
};

export default createClobClient;
