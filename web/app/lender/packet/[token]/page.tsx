import { headers } from "next/headers";
import { LenderPacketView } from "~~/components/robomata/LenderPacketView";
import { isRobomataShareLinksEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { buildResolvedSharedLenderPacketView } from "~~/lib/robomata/server/sharedLenderPacket";
import {
  getSubmissionShareLinkStore,
  hashShareLinkMetadataValue,
} from "~~/lib/robomata/server/submissionShareLinkStore";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { buildSharedLenderPacketView } from "~~/lib/robomata/shareLinks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type LenderPacketPageProps = {
  params: Promise<{ token: string }>;
};

type PacketLoadState =
  | { status: "ready"; packet: ReturnType<typeof buildSharedLenderPacketView> }
  | { status: "disabled" | "missing" | "revoked" | "expired" | "unavailable" | "error"; message: string };

function getClientIp(requestHeaders: Headers): string | null {
  const forwardedFor = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || requestHeaders.get("x-real-ip")?.trim() || null;
}

function buildAccessMetadata(requestHeaders: Headers) {
  const ip = getClientIp(requestHeaders);
  const userAgent = requestHeaders.get("user-agent")?.trim();

  return {
    ...(ip ? { ipHash: hashShareLinkMetadataValue(ip) } : {}),
    ...(userAgent ? { userAgentHash: hashShareLinkMetadataValue(userAgent) } : {}),
  };
}

async function loadPacket(token: string): Promise<PacketLoadState> {
  try {
    if (!isRobomataWorkflowServerEnabled() || !isRobomataShareLinksEnabled()) {
      return {
        status: "disabled",
        message: "Protected lender packet sharing is not enabled in this environment.",
      };
    }

    const shareLinkStore = getSubmissionShareLinkStore();
    const shareLink = await shareLinkStore.getByToken(token);
    if (!shareLink) {
      return { status: "missing", message: "This packet link was not found." };
    }
    if (shareLink.status === "revoked") {
      return { status: "revoked", message: "This packet link has been revoked by the operator." };
    }
    if (shareLink.status === "expired") {
      return { status: "expired", message: "This packet link has expired. Ask the operator for a fresh link." };
    }

    const submission = await getSubmissionStore().get(shareLink.submissionId);
    if (!submission || submission.partnerAddress.toLowerCase() !== shareLink.partnerAddress.toLowerCase()) {
      return { status: "missing", message: "This packet link is no longer attached to an available submission." };
    }
    if (!submission.computation?.lenderPacket) {
      return {
        status: "unavailable",
        message: "The lender packet is no longer available. Ask the operator to regenerate it.",
      };
    }

    const requestHeaders = await headers();
    const accessedShareLink = await shareLinkStore.recordAccess(shareLink, buildAccessMetadata(requestHeaders));
    if (!accessedShareLink) {
      return { status: "expired", message: "This packet link is no longer active." };
    }

    return {
      status: "ready",
      packet: await buildResolvedSharedLenderPacketView({ shareLink: accessedShareLink, submission }),
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Failed to load this lender packet.",
    };
  }
}

function PacketStateCard({ state }: { state: Exclude<PacketLoadState, { status: "ready" }> }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12 sm:px-6">
      <div className="rounded-[2rem] border border-base-300 bg-base-100 p-8 text-center shadow-lg shadow-base-300/30">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Robomata packet</p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-base-content">Packet unavailable</h1>
        <p className="mt-3 text-base leading-relaxed text-base-content/70">{state.message}</p>
        <a href="/robomata" className="btn btn-outline mt-6 rounded-full">
          Learn about Robomata
        </a>
      </div>
    </div>
  );
}

const LenderPacketPage = async ({ params }: LenderPacketPageProps) => {
  const { token } = await params;
  const state = await loadPacket(token);

  if (state.status !== "ready") return <PacketStateCard state={state} />;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <LenderPacketView packet={state.packet} shareToken={token} />
    </div>
  );
};

export default LenderPacketPage;
