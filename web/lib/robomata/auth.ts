export const ROBOMATA_AUTH_MAX_AGE_MS = 5 * 60 * 1000;

export const ROBOMATA_AUTH_HEADERS = {
  partnerAddress: "x-robomata-partner-address",
  signature: "x-robomata-auth-signature",
  timestamp: "x-robomata-auth-timestamp",
} as const;

type RobomataAuthMessageInput = {
  partnerAddress: string;
  timestamp: string;
};

export function buildRobomataAuthMessage({ partnerAddress, timestamp }: RobomataAuthMessageInput): string {
  return [
    "Robomata FacilitySubmission API access",
    `Partner: ${partnerAddress.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}
