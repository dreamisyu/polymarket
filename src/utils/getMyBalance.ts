import { Contract, JsonRpcProvider, formatUnits } from 'ethers';
import { ENV } from '../config/env';

const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const getMyBalance = async (address: string): Promise<number | null> => {
    try {
        const rpcProvider = new JsonRpcProvider(RPC_URL);
        const usdcContract = new Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, rpcProvider);
        const balanceUsdc = await usdcContract.balanceOf(address);
        return parseFloat(formatUnits(balanceUsdc, 6));
    } catch (error) {
        console.error(`Error fetching balance for ${address}:`, error);
        return null;
    }
};

export default getMyBalance;
