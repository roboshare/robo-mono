import { NextRequest, NextResponse } from "next/server";
import { SUI_TYPE_ARG, isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { getRobomataSuiClient, getRobomataSuiNetwork } from "~~/lib/robomata/server/suiCommitConfig";

const SUI_METADATA = {
  coinType: SUI_TYPE_ARG,
  decimals: 9,
  symbol: "SUI",
};

function coinTypeLabel(coinType: string) {
  const parts = coinType.split("::");
  return parts[parts.length - 1] || "Coin";
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address")?.trim();
  if (!address || !isValidSuiAddress(address)) {
    return NextResponse.json({ error: "A valid Sui address is required." }, { status: 400 });
  }

  try {
    const client = getRobomataSuiClient();
    const network = getRobomataSuiNetwork();
    const balances = await client.getAllBalances({ owner: normalizeSuiAddress(address) });

    const enrichedBalances = await Promise.all(
      balances.map(async balance => {
        if (balance.coinType === SUI_TYPE_ARG) {
          return {
            coinType: balance.coinType,
            decimals: SUI_METADATA.decimals,
            symbol: SUI_METADATA.symbol,
            totalBalance: balance.totalBalance,
          };
        }

        const metadata = await client.getCoinMetadata({ coinType: balance.coinType }).catch(() => null);
        return {
          coinType: balance.coinType,
          decimals: metadata?.decimals ?? 0,
          symbol: metadata?.symbol ?? coinTypeLabel(balance.coinType),
          totalBalance: balance.totalBalance,
        };
      }),
    );

    const sortedBalances = enrichedBalances.sort((left, right) => {
      if (left.coinType === SUI_TYPE_ARG) return -1;
      if (right.coinType === SUI_TYPE_ARG) return 1;
      return left.symbol.localeCompare(right.symbol);
    });

    return NextResponse.json({
      address: normalizeSuiAddress(address),
      balances: sortedBalances,
      network,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load Sui balances." },
      { status: 503 },
    );
  }
}
