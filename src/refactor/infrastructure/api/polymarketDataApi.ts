import type { UserPositionInterface } from '../../../interfaces/User';
import fetchData from '../../../utils/fetchData';

export const fetchPositions = async (address: string) => {
    const normalizedAddress = String(address || '').trim();
    if (!normalizedAddress) {
        return [] as UserPositionInterface[];
    }

    const response = await fetchData<UserPositionInterface[]>(
        `https://data-api.polymarket.com/positions?user=${normalizedAddress}&sizeThreshold=0`
    );

    return Array.isArray(response) ? response : [];
};
