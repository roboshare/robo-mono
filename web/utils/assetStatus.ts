/** Matches AssetLib.AssetStatus.Expired (4) and AssetLib.AssetStatus.Retired (5). */
export const isSettledAssetStatus = (status: number): boolean => status === 4 || status === 5;
