import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataPrivySuiWalletBindingEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { ensurePrivySuiWalletBinding, getPrivySuiWalletBinding } from "~~/lib/robomata/server/privySuiWallets";
import { getPrivyUserFromRequest, requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

export const runtime = "nodejs";

function requireRobomataWalletBinding() {
  if (isRobomataWorkflowServerEnabled() && isRobomataPrivySuiWalletBindingEnabled()) return null;
  return NextResponse.json({ error: "Robomata Privy Sui wallet binding is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

async function requirePrivyUser(request: NextRequest) {
  try {
    const user = await getPrivyUserFromRequest(request);
    if (user) return user;
  } catch {
    // Fall through to a stable API error below.
  }
  return NextResponse.json({ error: "Missing or invalid Privy session." }, { status: 401 });
}

export async function GET(request: NextRequest) {
  const featureError = requireRobomataWalletBinding();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const user = await requirePrivyUser(request);
  if (user instanceof NextResponse) return user;

  const binding = await getPrivySuiWalletBinding(user.id);
  return NextResponse.json({ binding });
}

export async function POST(request: NextRequest) {
  const featureError = requireRobomataWalletBinding();
  if (featureError) return featureError;
  const mutationError = requireRobomataMutation();
  if (mutationError) return mutationError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const user = await requirePrivyUser(request);
  if (user instanceof NextResponse) return user;

  try {
    const binding = await ensurePrivySuiWalletBinding({ partnerAddress, privyUserId: user.id });
    return NextResponse.json({ binding });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to ensure Privy Sui operator wallet: ${error.message}`
            : "Failed to ensure Privy Sui operator wallet.",
      },
      { status: 500 },
    );
  }
}
