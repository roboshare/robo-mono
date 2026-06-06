"use client";

// @refresh reset
import { useState } from "react";
import { Balance } from "../Balance";
import { AddressInfoDropdown } from "./AddressInfoDropdown";
import { AddressQRCodeModal } from "./AddressQRCodeModal";
import { WrongNetworkDropdown } from "./WrongNetworkDropdown";
import { useCreateWallet, useLogout, usePrivy } from "@privy-io/react-auth";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Address, formatUnits } from "viem";
import { useAccount, useDisconnect } from "wagmi";
import { useNetworkColor, useSelectedNetwork, useWatchTokenBalance } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { isPrivyEnabled } from "~~/services/web3/privyConfig";
import { getPrivyIdentityLabel } from "~~/services/web3/privyIdentity";
import { getBlockExplorerAddressLink, notification } from "~~/utils/scaffold-eth";

const ConnectedWalletSummary = ({ address, chainName }: { address: Address; chainName?: string }) => {
  const networkColor = useNetworkColor();
  const {
    address: paymentTokenAddress,
    symbol: paymentTokenSymbol,
    decimals: paymentTokenDecimals,
  } = usePaymentToken();
  const { data: paymentTokenBalance } = useWatchTokenBalance({
    tokenAddress: paymentTokenAddress,
    ownerAddress: address,
  });

  const formattedPaymentTokenBalance =
    paymentTokenBalance !== undefined
      ? Number(formatUnits(paymentTokenBalance as bigint, paymentTokenDecimals)).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : null;

  return (
    <div className="hidden sm:block mr-2 text-right leading-tight">
      <Balance address={address} className="min-h-0 h-auto p-0 justify-end ml-auto" />
      {formattedPaymentTokenBalance !== null ? (
        <span className="block text-xs font-medium text-base-content/70">
          {formattedPaymentTokenBalance} {paymentTokenSymbol}
        </span>
      ) : null}
      {chainName ? (
        <span className="block text-[11px]" style={{ color: networkColor }}>
          {chainName}
        </span>
      ) : null}
    </div>
  );
};

type ConnectedWalletContentProps = {
  address: Address;
  chainName?: string;
  displayName: string;
  ensAvatar?: string;
  onDisconnect?: () => void | Promise<void>;
};

const ConnectedWalletContent = ({
  address,
  chainName,
  displayName,
  ensAvatar,
  onDisconnect,
}: ConnectedWalletContentProps) => {
  const { targetNetwork } = useTargetNetwork();
  const blockExplorerAddressLink = getBlockExplorerAddressLink(targetNetwork, address);

  return (
    <>
      <div className="flex flex-col items-end">
        <div className="flex items-center">
          <ConnectedWalletSummary address={address} chainName={chainName} />
          <AddressInfoDropdown
            address={address}
            displayName={displayName}
            ensAvatar={ensAvatar}
            blockExplorerAddressLink={blockExplorerAddressLink}
            chainName={chainName}
            onDisconnect={onDisconnect}
          />
        </div>
      </div>
      <AddressQRCodeModal address={address} modalId="qrcode-modal" />
    </>
  );
};

const LegacyRainbowKitConnectButton = () => {
  const { targetNetwork } = useTargetNetwork();

  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, mounted }) => {
        const connected = mounted && account && chain;

        return (
          <>
            {(() => {
              if (!connected) {
                return (
                  <button className="btn btn-primary btn-sm" onClick={openConnectModal} type="button">
                    Connect Wallet
                  </button>
                );
              }

              if (chain.unsupported || chain.id !== targetNetwork.id) {
                return <WrongNetworkDropdown />;
              }

              return (
                <ConnectedWalletContent
                  address={account.address as Address}
                  chainName={chain.name}
                  displayName={account.displayName}
                  ensAvatar={account.ensAvatar}
                />
              );
            })()}
          </>
        );
      }}
    </ConnectButton.Custom>
  );
};

const PrivyConnectButton = () => {
  const { targetNetwork } = useTargetNetwork();
  const { chain, connector } = useAccount();
  const { address: transactingAddress, chainId: transactingChainId } = useTransactingAccount();
  const { disconnect } = useDisconnect();
  const { ready, authenticated, login, connectWallet, user } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { logout } = useLogout();
  const [isCreatingWallet, setIsCreatingWallet] = useState(false);
  const [walletCreationError, setWalletCreationError] = useState<string | null>(null);
  const selectedNetwork = useSelectedNetwork(transactingChainId);
  const transactingChainName = selectedNetwork.name;

  const handleDisconnect = async () => {
    const isPrivyConnector = connector?.id.startsWith("io.privy");

    if (authenticated || isPrivyConnector) {
      try {
        await logout();
      } finally {
        // External wallets connected through Privy can remain attached at the wagmi layer
        // after logout, so explicitly disconnect the connector as well.
        disconnect();
      }
      return;
    }

    disconnect();
  };

  const handleCreateEmbeddedWallet = async () => {
    setIsCreatingWallet(true);
    setWalletCreationError(null);

    try {
      await createWallet();
      notification.success("Embedded wallet created. Reloading wallet session...");
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create embedded wallet.";
      setWalletCreationError(message);
      notification.error(message);
    } finally {
      setIsCreatingWallet(false);
    }
  };

  if (!ready) {
    return (
      <button className="btn btn-primary btn-sm" disabled type="button">
        Loading...
      </button>
    );
  }

  if (!authenticated && (!transactingAddress || !chain)) {
    return (
      <button className="btn btn-primary btn-sm" onClick={() => login()} type="button">
        Get Started
      </button>
    );
  }

  if (!transactingAddress || !chain) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <button
            className="btn btn-primary btn-sm"
            disabled={isCreatingWallet}
            onClick={handleCreateEmbeddedWallet}
            type="button"
          >
            {isCreatingWallet ? "Creating..." : "Create app wallet"}
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => connectWallet()} type="button">
            Connect external
          </button>
        </div>
        {walletCreationError ? (
          <span className="max-w-[18rem] text-right text-xs text-error">{walletCreationError}</span>
        ) : null}
      </div>
    );
  }

  if (chain.id !== targetNetwork.id) {
    return <WrongNetworkDropdown onDisconnect={handleDisconnect} />;
  }

  return (
    <ConnectedWalletContent
      address={transactingAddress}
      chainName={transactingChainName}
      displayName={
        getPrivyIdentityLabel({ address: transactingAddress, connectorName: connector?.name, user }) ||
        `${transactingAddress.slice(0, 6)}...${transactingAddress.slice(-4)}`
      }
      onDisconnect={handleDisconnect}
    />
  );
};

/**
 * Custom Wagmi Connect Button (watch balance + custom design)
 */
export const RainbowKitCustomConnectButton = () => {
  return isPrivyEnabled() ? <PrivyConnectButton /> : <LegacyRainbowKitConnectButton />;
};
