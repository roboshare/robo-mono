import { PROTOCOL_FEE_BP, calculateProtocolEarnings } from "~~/config/protocol";
import { SECONDS_PER_QUARTER } from "~~/config/units";

export const calculatePrimaryPoolBuffers = (baseAmount: bigint, targetYieldBP: bigint, protectionEnabled: boolean) => {
  const protocolBuffer = calculateProtocolEarnings(baseAmount, SECONDS_PER_QUARTER, PROTOCOL_FEE_BP);
  const protectionBuffer = calculateProtocolEarnings(baseAmount, SECONDS_PER_QUARTER, targetYieldBP);
  const totalBuffer = protocolBuffer + (protectionEnabled ? protectionBuffer : 0n);

  return {
    protocolBuffer,
    protectionBuffer,
    totalBuffer,
  };
};
