import { Contract, JsonRpcProvider, formatUnits } from 'ethers';
import { ENV } from '../config/env';
import createLogger from './logger';

const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;
const logger = createLogger('balance');

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

let rpcProvider: JsonRpcProvider | null = null;

export const getRpcProvider = () => {
    if (!rpcProvider) {
        rpcProvider = new JsonRpcProvider(RPC_URL);
    }

    return rpcProvider;
};

const getMyBalance = async (address: string): Promise<number | null> => {
    try {
        const usdcContract = new Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, getRpcProvider());
        const balanceUsdc = await usdcContract.balanceOf(address);
        return parseFloat(formatUnits(balanceUsdc, 6));
    } catch (error) {
        logger.error(`读取余额失败 address=${address}`, error);
        return null;
    }
};

export default getMyBalance;
