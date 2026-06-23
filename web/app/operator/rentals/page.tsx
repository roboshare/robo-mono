import { RentalHostOperationsExperience } from "~~/components/robomata/RentalHostOperationsExperience";
import { isRobomataRentalHostOpsClientEnabled } from "~~/lib/featureFlags";

const RentalHostOperationsPage = () =>
  isRobomataRentalHostOpsClientEnabled() ? (
    <RentalHostOperationsExperience />
  ) : (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
      <div className="rounded-[2rem] border border-base-300 bg-base-100 p-8 text-center shadow-lg shadow-base-300/30">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Feature disabled</p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-base-content">
          Rental host operations are not enabled in this environment.
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-base-content/70">
          Set <code>NEXT_PUBLIC_ROBOMATA_RENTAL_HOST_OPS_ENABLED=true</code> to expose the operator rental setup,
          controls, and trip handoff workspace.
        </p>
      </div>
    </div>
  );

export default RentalHostOperationsPage;
