import { useRef, useState } from "react";
import { NetworkOptions } from "./NetworkOptions";
import { Address, formatEther, formatUnits, getAddress } from "viem";
import { useDisconnect } from "wagmi";
import {
  ArrowLeftOnRectangleIcon,
  ArrowTopRightOnSquareIcon,
  ArrowsRightLeftIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  DocumentDuplicateIcon,
  QrCodeIcon,
} from "@heroicons/react/24/outline";
import { BlockieAvatar, isENS } from "~~/components/scaffold-eth";
import {
  useCopyToClipboard,
  useNetworkColor,
  useOutsideClick,
  useWatchBalance,
  useWatchTokenBalance,
} from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { getTargetNetworks } from "~~/utils/scaffold-eth";

const allowedNetworks = getTargetNetworks();

type AddressInfoDropdownProps = {
  address: Address;
  blockExplorerAddressLink: string | undefined;
  displayName: string;
  ensAvatar?: string;
  chainName?: string;
  onDisconnect?: () => void | Promise<void>;
};

export const AddressInfoDropdown = ({
  address,
  ensAvatar,
  displayName,
  blockExplorerAddressLink,
  chainName,
  onDisconnect,
}: AddressInfoDropdownProps) => {
  const { disconnect } = useDisconnect();
  const checkSumAddress = getAddress(address);
  const networkColor = useNetworkColor();
  const {
    address: paymentTokenAddress,
    symbol: paymentTokenSymbol,
    decimals: paymentTokenDecimals,
  } = usePaymentToken();
  const { data: nativeBalance } = useWatchBalance({ address });
  const { data: paymentTokenBalance } = useWatchTokenBalance({
    tokenAddress: paymentTokenAddress,
    ownerAddress: address,
  });

  const formattedNativeBalance =
    nativeBalance !== undefined
      ? Number(formatEther(nativeBalance.value)).toLocaleString(undefined, {
          minimumFractionDigits: 4,
          maximumFractionDigits: 4,
        })
      : null;

  const formattedPaymentTokenBalance =
    paymentTokenBalance !== undefined
      ? Number(formatUnits(paymentTokenBalance as bigint, paymentTokenDecimals)).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : null;

  const { copyToClipboard: copyAddressToClipboard, isCopiedToClipboard: isAddressCopiedToClipboard } =
    useCopyToClipboard();
  const [selectingNetwork, setSelectingNetwork] = useState(false);
  const dropdownRef = useRef<HTMLDetailsElement>(null);

  const closeDropdown = () => {
    setSelectingNetwork(false);
    dropdownRef.current?.removeAttribute("open");
  };

  const handleDisconnect = () => {
    closeDropdown();
    void (onDisconnect ? onDisconnect() : disconnect());
  };

  useOutsideClick(dropdownRef, closeDropdown);

  const summaryLabel = isENS(displayName)
    ? displayName
    : displayName && displayName !== checkSumAddress
      ? displayName
      : checkSumAddress?.slice(0, 6) + "..." + checkSumAddress?.slice(-4);

  return (
    <>
      <details ref={dropdownRef} className="dropdown dropdown-end leading-3">
        <summary className="btn btn-secondary btn-sm pl-0 pr-2 shadow-md dropdown-toggle gap-0 h-auto!">
          <BlockieAvatar address={checkSumAddress} size={30} ensImage={ensAvatar} />
          <span className="ml-2 mr-1 max-w-40 truncate">{summaryLabel}</span>
          <ChevronDownIcon className="h-6 w-4 ml-2 sm:ml-0" />
        </summary>
        <ul className="dropdown-content menu z-2 p-2 mt-2 shadow-center shadow-accent bg-base-200 rounded-box gap-1">
          <li className={`${selectingNetwork ? "hidden" : ""} w-full border-b border-base-300/80 px-3 py-2 sm:hidden`}>
            <div className="pointer-events-none !flex !w-full !flex-col !items-end !justify-start !gap-0.5 !bg-transparent !px-0 !py-0 text-right leading-tight shadow-none">
              {formattedNativeBalance !== null ? (
                <div className="flex items-baseline justify-end gap-1 text-sm font-semibold text-base-content">
                  <span>{formattedNativeBalance}</span>
                  <span className="text-[11px] font-bold text-base-content/80">ETH</span>
                </div>
              ) : null}
              {formattedPaymentTokenBalance !== null ? (
                <div className="text-xs font-medium text-base-content/70">
                  <span>
                    {formattedPaymentTokenBalance} {paymentTokenSymbol}
                  </span>
                </div>
              ) : null}
              {chainName ? (
                <div>
                  <span className="text-[11px]" style={{ color: networkColor }}>
                    {chainName}
                  </span>
                </div>
              ) : null}
            </div>
          </li>
          <NetworkOptions hidden={!selectingNetwork} />
          <li className={selectingNetwork ? "hidden" : ""}>
            <div
              className="h-8 btn-sm rounded-xl! flex gap-3 py-3 cursor-pointer"
              onClick={() => copyAddressToClipboard(checkSumAddress)}
            >
              {isAddressCopiedToClipboard ? (
                <>
                  <CheckCircleIcon className="text-xl font-normal h-6 w-4 ml-2 sm:ml-0" aria-hidden="true" />
                  <span className="whitespace-nowrap">Copied!</span>
                </>
              ) : (
                <>
                  <DocumentDuplicateIcon className="text-xl font-normal h-6 w-4 ml-2 sm:ml-0" aria-hidden="true" />
                  <span className="whitespace-nowrap">Copy address</span>
                </>
              )}
            </div>
          </li>
          <li className={selectingNetwork ? "hidden" : ""}>
            <label htmlFor="qrcode-modal" className="h-8 btn-sm rounded-xl! flex gap-3 py-3">
              <QrCodeIcon className="h-6 w-4 ml-2 sm:ml-0" />
              <span className="whitespace-nowrap">View QR Code</span>
            </label>
          </li>
          <li className={selectingNetwork ? "hidden" : ""}>
            <button className="h-8 btn-sm rounded-xl! flex gap-3 py-3" type="button">
              <ArrowTopRightOnSquareIcon className="h-6 w-4 ml-2 sm:ml-0" />
              <a
                target="_blank"
                href={blockExplorerAddressLink}
                rel="noopener noreferrer"
                className="whitespace-nowrap"
              >
                View on Block Explorer
              </a>
            </button>
          </li>
          {allowedNetworks.length > 1 ? (
            <li className={selectingNetwork ? "hidden" : ""}>
              <button
                className="h-8 btn-sm rounded-xl! flex gap-3 py-3"
                type="button"
                onClick={() => {
                  setSelectingNetwork(true);
                }}
              >
                <ArrowsRightLeftIcon className="h-6 w-4 ml-2 sm:ml-0" /> <span>Switch Network</span>
              </button>
            </li>
          ) : null}
          <li className={selectingNetwork ? "hidden" : ""}>
            <button
              className="menu-item text-error h-8 btn-sm rounded-xl! flex gap-3 py-3"
              type="button"
              onClick={handleDisconnect}
            >
              <ArrowLeftOnRectangleIcon className="h-6 w-4 ml-2 sm:ml-0" /> <span>Disconnect</span>
            </button>
          </li>
        </ul>
      </details>
    </>
  );
};
