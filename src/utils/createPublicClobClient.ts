import { Chain, ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';

const createPublicClobClient = () =>
    new ClobClient(
        ENV.CLOB_HTTP_URL,
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

export default createPublicClobClient;
