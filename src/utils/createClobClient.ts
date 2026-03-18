import { ClobClient, SignatureType } from '@polymarket/clob-client';
import { TypedDataDomain, TypedDataField, Wallet } from 'ethers';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

type TypedDataTypes = Record<string, Array<TypedDataField>>;
type TypedDataValue = Record<string, unknown>;

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
    const bootstrapClient = new ClobClient(
        CLOB_HTTP_URL,
        chainId,
        signer,
        undefined,
        SignatureType.POLY_GNOSIS_SAFE,
        PROXY_WALLET
    );
    const creds = await bootstrapClient.createOrDeriveApiKey();

    return new ClobClient(
        CLOB_HTTP_URL,
        chainId,
        signer,
        creds,
        SignatureType.POLY_GNOSIS_SAFE,
        PROXY_WALLET
    );
};

export default createClobClient;
