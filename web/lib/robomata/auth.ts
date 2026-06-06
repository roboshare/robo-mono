export const ROBOMATA_AUTH_MAX_AGE_MS = 5 * 60 * 1000;

export const ROBOMATA_AUTH_HEADERS = {
  chainId: "x-robomata-chain-id",
  method: "x-robomata-auth-method",
  path: "x-robomata-auth-path",
  partnerAddress: "x-robomata-partner-address",
  signerAddress: "x-robomata-signer-address",
  signature: "x-robomata-auth-signature",
  timestamp: "x-robomata-auth-timestamp",
} as const;

type RobomataAuthMessageInput = {
  chainId?: number | string;
  method?: string;
  path?: string;
  partnerAddress: string;
  signerAddress?: string;
  timestamp: string;
};

export function buildRobomataAuthMessage({
  chainId,
  method = "GET",
  path = "/api/robomata/submissions",
  partnerAddress,
  signerAddress = partnerAddress,
  timestamp,
}: RobomataAuthMessageInput): string {
  return [
    "Robomata FacilitySubmission API access",
    `Method: ${method.toUpperCase()}`,
    `Path: ${path}`,
    ...(chainId ? [`Chain: ${chainId}`] : []),
    `Partner: ${partnerAddress.toLowerCase()}`,
    `Signer: ${signerAddress.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}
