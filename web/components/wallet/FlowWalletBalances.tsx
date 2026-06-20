"use client";

import { useEffect, useMemo, useState } from "react";
import { Address, formatUnits } from "viem";
import { useBalance } from "wagmi";
import { CircleStackIcon, CubeTransparentIcon, ShieldCheckIcon, WalletIcon } from "@heroicons/react/24/outline";

type EvmBalanceFlow = {
  address?: Address;
  chainId: number;
  chainName: string;
  feesSponsored?: boolean;
  flowLabel: string;
  paymentToken?: {
    address?: Address;
    decimals: number;
    symbol: string;
  };
};

type SuiBalanceFlow = {
  address?: string;
  flowLabel: string;
};

type FlowWalletBalancesProps = {
  evm?: EvmBalanceFlow;
  sui?: SuiBalanceFlow;
};

type SuiBalance = {
  coinType: string;
  decimals: number;
  symbol: string;
  totalBalance: string;
};

type SuiBalanceResponse = {
  balances?: SuiBalance[];
  error?: string;
  network?: string;
};

function formatAmount(value: bigint | string | undefined, decimals: number) {
  if (value === undefined) return "0";

  const rawValue = typeof value === "bigint" ? value : BigInt(value || "0");
  const formatted = formatUnits(rawValue, decimals);
  const numeric = Number(formatted);
  if (!Number.isFinite(numeric)) return formatted;

  return numeric.toLocaleString(undefined, {
    maximumFractionDigits: numeric === 0 ? 0 : numeric < 1 ? 6 : 4,
  });
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const rowClass =
  "flex min-w-0 items-center justify-between gap-3 rounded-xl border border-base-300 bg-base-100 px-3 py-2";

function BalanceRow({
  isLoading,
  label,
  sublabel,
  symbol,
  value,
}: {
  isLoading?: boolean;
  label: string;
  sublabel?: string;
  symbol: string;
  value: string;
}) {
  return (
    <div className={rowClass}>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-base-content">{label}</div>
        {sublabel ? <div className="truncate text-xs text-base-content/50">{sublabel}</div> : null}
      </div>
      <div className="shrink-0 text-right">
        {isLoading ? (
          <span className="loading loading-spinner loading-xs text-primary" />
        ) : (
          <>
            <div className="font-mono text-sm font-semibold text-base-content">{value}</div>
            <div className="text-xs font-semibold text-base-content/50">{symbol}</div>
          </>
        )}
      </div>
    </div>
  );
}

function EvmFlowBalanceCard({ flow }: { flow: EvmBalanceFlow }) {
  const paymentTokenBalance = useBalance({
    address: flow.address,
    chainId: flow.chainId,
    token: flow.paymentToken?.address,
    query: { enabled: Boolean(flow.address && flow.paymentToken?.address) },
  });

  return (
    <section className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-base-content">
            <WalletIcon className="h-4 w-4 text-primary" />
            {flow.flowLabel}
          </div>
          <div className="mt-1 truncate text-xs text-base-content/60">
            {flow.address ? shortAddress(flow.address) : "Connect wallet to load balances"}
          </div>
        </div>
        <div className="shrink-0 rounded-full border border-base-300 bg-base-100 px-3 py-1 text-xs font-semibold text-base-content/70">
          {flow.chainName}
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {flow.paymentToken?.address ? (
          <BalanceRow
            isLoading={paymentTokenBalance.isLoading}
            label="Payment token"
            sublabel={shortAddress(flow.paymentToken.address)}
            symbol={paymentTokenBalance.data?.symbol ?? flow.paymentToken.symbol}
            value={formatAmount(
              paymentTokenBalance.data?.value,
              paymentTokenBalance.data?.decimals ?? flow.paymentToken.decimals,
            )}
          />
        ) : (
          <NoPaymentTokenRow sublabel="No token configured for this network" />
        )}
        <NetworkFeesRow sponsored={Boolean(flow.feesSponsored)} />
      </div>
    </section>
  );
}

function SuiFlowBalanceCard({ flow }: { flow: SuiBalanceFlow }) {
  const [payload, setPayload] = useState<SuiBalanceResponse>({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let ignore = false;

    if (!flow.address) {
      setPayload({});
      return;
    }

    setIsLoading(true);
    fetch(`/api/robomata/sui/balances?address=${encodeURIComponent(flow.address)}`)
      .then(async response => {
        const json = (await response.json().catch(() => ({}))) as SuiBalanceResponse;
        if (!response.ok) throw new Error(json.error ?? "Failed to load Sui balances.");
        return json;
      })
      .then(json => {
        if (!ignore) setPayload(json);
      })
      .catch(error => {
        if (!ignore) setPayload({ error: error instanceof Error ? error.message : "Failed to load Sui balances." });
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [flow.address]);

  const displayedBalances = useMemo(
    () =>
      (payload.balances ?? [])
        .filter(balance => balance.symbol !== "SUI" && !balance.coinType.endsWith("::sui::SUI"))
        .slice(0, 3),
    [payload.balances],
  );

  return (
    <section className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-base-content">
            <CubeTransparentIcon className="h-4 w-4 text-primary" />
            {flow.flowLabel}
          </div>
          <div className="mt-1 truncate text-xs text-base-content/60">
            {flow.address ? shortAddress(flow.address) : "No Sui operator wallet bound yet"}
          </div>
        </div>
        <div className="shrink-0 rounded-full border border-base-300 bg-base-100 px-3 py-1 text-xs font-semibold capitalize text-base-content/70">
          {payload.network ?? "Sui"}
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {displayedBalances.length ? (
          displayedBalances.map(balance => (
            <BalanceRow
              key={balance.coinType}
              isLoading={isLoading}
              label={balance.symbol}
              sublabel={balance.coinType}
              symbol={balance.symbol}
              value={formatAmount(balance.totalBalance, balance.decimals)}
            />
          ))
        ) : flow.address && !isLoading && !payload.error ? (
          <NoPaymentTokenRow sublabel="Not required for this flow" />
        ) : (
          <div className="rounded-xl border border-dashed border-base-300 bg-base-100 px-3 py-3 text-sm text-base-content/60 sm:col-span-2">
            {isLoading
              ? "Loading Sui balances..."
              : payload.error
                ? payload.error
                : "Bind the operator Sui wallet to load balances."}
          </div>
        )}
        <NetworkFeesRow sponsored />
      </div>
    </section>
  );
}

function NoPaymentTokenRow({ sublabel }: { sublabel: string }) {
  return (
    <div className={rowClass}>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-base-content">Payment token</div>
        <div className="truncate text-xs text-base-content/50">{sublabel}</div>
      </div>
      <CircleStackIcon className="h-5 w-5 shrink-0 text-base-content/40" />
    </div>
  );
}

function NetworkFeesRow({ sponsored }: { sponsored: boolean }) {
  return (
    <div className={rowClass}>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-base-content">Network fees</div>
        <div className="truncate text-xs text-base-content/50">
          {sponsored ? "Sponsored for this flow" : "Native gas may be required"}
        </div>
      </div>
      <ShieldCheckIcon className={`h-5 w-5 shrink-0 ${sponsored ? "text-success" : "text-base-content/40"}`} />
    </div>
  );
}

export function FlowWalletBalances({ evm, sui }: FlowWalletBalancesProps) {
  if (!evm && !sui) return null;

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {sui ? <SuiFlowBalanceCard flow={sui} /> : null}
      {evm ? <EvmFlowBalanceCard flow={evm} /> : null}
    </div>
  );
}
