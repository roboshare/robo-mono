"use client";

import { useState } from "react";
import { useCreateWallet, usePrivy } from "@privy-io/react-auth";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { ArrowRightIcon, ShieldCheckIcon } from "@heroicons/react/24/outline";
import { isPrivyEnabled } from "~~/services/web3/privyConfig";
import { notification } from "~~/utils/scaffold-eth";

const PrivyOperatorLoginAction = () => {
  const { ready, authenticated, login, connectWallet } = usePrivy();
  const { createWallet } = useCreateWallet();
  const [isCreatingWallet, setIsCreatingWallet] = useState(false);

  const handleCreateEmbeddedWallet = async () => {
    setIsCreatingWallet(true);

    try {
      await createWallet();
      notification.success("Embedded wallet created. Reloading wallet session...");
      window.location.reload();
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to create embedded wallet.");
    } finally {
      setIsCreatingWallet(false);
    }
  };

  if (!authenticated) {
    return (
      <button
        className="btn btn-primary rounded-full px-6 shadow-md shadow-primary/20"
        disabled={!ready}
        onClick={() => login()}
        type="button"
      >
        {ready ? "Get Started" : "Loading..."}
        {ready ? <ArrowRightIcon className="h-4 w-4" /> : null}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
      <button
        className="btn btn-primary rounded-full px-6 shadow-md shadow-primary/20"
        disabled={!ready || isCreatingWallet}
        onClick={handleCreateEmbeddedWallet}
        type="button"
      >
        {isCreatingWallet ? "Creating..." : "Create app wallet"}
      </button>
      <button
        className="btn btn-outline rounded-full px-6"
        disabled={!ready}
        onClick={() => connectWallet()}
        type="button"
      >
        Connect external
      </button>
    </div>
  );
};

const LegacyOperatorLoginAction = () => {
  const { openConnectModal } = useConnectModal();

  return (
    <button
      className="btn btn-primary rounded-full px-6 shadow-md shadow-primary/20"
      disabled={!openConnectModal}
      onClick={() => openConnectModal?.()}
      type="button"
    >
      {openConnectModal ? "Connect Wallet" : "Loading..."}
      {openConnectModal ? <ArrowRightIcon className="h-4 w-4" /> : null}
    </button>
  );
};

const OperatorLoginAction = () => {
  return isPrivyEnabled() ? <PrivyOperatorLoginAction /> : <LegacyOperatorLoginAction />;
};

export const OperatorLoginRequired = () => {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6">
      <div className="max-w-xl rounded-[2rem] border border-base-300 bg-base-100/90 p-8 text-center shadow-xl shadow-secondary/20">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ShieldCheckIcon className="h-6 w-6" />
        </div>
        <p className="mt-6 text-xs font-bold uppercase tracking-[0.28em] text-base-content/50">Operator Portal</p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-base-content">Log in to continue.</h1>
        <p className="mt-4 text-base leading-7 text-base-content/70">
          Access borrowing-base submissions, facility monitoring, and operator workflows from your authorized Roboshare
          account.
        </p>
        <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <OperatorLoginAction />
          <a href="/products/robomata" className="btn btn-outline rounded-full px-6">
            Learn about Robomata
          </a>
        </div>
      </div>
    </div>
  );
};
