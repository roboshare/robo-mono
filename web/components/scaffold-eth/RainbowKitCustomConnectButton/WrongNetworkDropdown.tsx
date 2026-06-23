import { NetworkOptions } from "./NetworkOptions";
import { useDisconnect } from "wagmi";
import { ArrowLeftOnRectangleIcon, ChevronDownIcon } from "@heroicons/react/24/outline";

type WrongNetworkDropdownProps = {
  disconnectLabel?: string;
  onDisconnect?: () => void | Promise<void>;
  showNetworkOptions?: boolean;
};

export const WrongNetworkDropdown = ({
  disconnectLabel = "Disconnect",
  onDisconnect,
  showNetworkOptions = true,
}: WrongNetworkDropdownProps) => {
  const { disconnect } = useDisconnect();

  return (
    <div className="dropdown dropdown-end mr-2">
      <label tabIndex={0} className="btn btn-error btn-sm dropdown-toggle gap-1">
        <span>Wrong network</span>
        <ChevronDownIcon className="h-6 w-4 ml-2 sm:ml-0" />
      </label>
      <ul
        tabIndex={0}
        className="dropdown-content menu p-2 mt-1 shadow-center shadow-accent bg-base-200 rounded-box gap-1"
      >
        {showNetworkOptions ? <NetworkOptions /> : null}
        <li>
          <button
            className="menu-item text-error btn-sm rounded-xl! flex gap-3 py-3"
            type="button"
            onClick={() => {
              void (onDisconnect ? onDisconnect() : disconnect());
            }}
          >
            <ArrowLeftOnRectangleIcon className="h-6 w-4 ml-2 sm:ml-0" />
            <span>{disconnectLabel}</span>
          </button>
        </li>
      </ul>
    </div>
  );
};
