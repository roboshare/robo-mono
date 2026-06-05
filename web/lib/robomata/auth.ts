export const ROBOMATA_AUTH_MAX_AGE_MS = 5 * 60 * 1000;

export const ROBOMATA_AUTH_HEADERS = {
  partnerAddress: "x-robomata-partner-address",
  signerAddress: "x-robomata-signer-address",
  signature: "x-robomata-auth-signature",
  timestamp: "x-robomata-auth-timestamp",
} as const;

type RobomataAuthMessageInput = {
  partnerAddress: string;
  signerAddress?: string;
  timestamp: string;
};

export function buildRobomataAuthMessage({
  partnerAddress,
  signerAddress = partnerAddress,
  timestamp,
}: RobomataAuthMessageInput): string {
  return [
    "Robomata FacilitySubmission API access",
    `Partner: ${partnerAddress.toLowerCase()}`,
    `Signer: ${signerAddress.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}
