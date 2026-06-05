"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlusIcon } from "@heroicons/react/24/outline";
import { PartnerAccessGate } from "~~/components/partner/PartnerAccessGate";
import { useRobomataApiAuth } from "~~/hooks/useRobomataApiAuth";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";
import { notification } from "~~/utils/scaffold-eth";

function statusClass(status: FacilitySubmission["status"]) {
  if (status === "committed") return "badge-success";
  if (status === "ready_for_lender") return "badge-info";
  if (status === "needs_review") return "badge-warning";
  return "badge-ghost";
}

export const SubmissionIndex = () => {
  const router = useRouter();
  const { address: accountAddress, connectedAddress } = useTransactingAccount();
  const partnerAuthAddress = accountAddress;
  const signerAddress = connectedAddress ?? accountAddress;
  const getAuthHeaders = useRobomataApiAuth(partnerAuthAddress);
  const [submissions, setSubmissions] = useState<FacilitySubmission[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState({
    operatorName: "",
    facilityName: "",
    asOfDate: new Date().toISOString().slice(0, 10),
  });

  useEffect(() => {
    if (!partnerAuthAddress) return;

    const load = async () => {
      setIsLoading(true);
      const response = await fetch("/api/robomata/submissions", { headers: await getAuthHeaders(signerAddress) });
      const payload = (await response.json()) as { submissions?: FacilitySubmission[]; error?: string };
      if (!response.ok) {
        notification.error(payload.error ?? "Failed to load submissions.");
        setIsLoading(false);
        return;
      }
      setSubmissions(payload.submissions ?? []);
      setIsLoading(false);
    };

    void load();
  }, [getAuthHeaders, partnerAuthAddress, signerAddress]);

  const createSubmission = async () => {
    if (!partnerAuthAddress || !form.operatorName.trim() || !form.facilityName.trim() || !form.asOfDate) {
      notification.error("Complete the submission details first.");
      return;
    }

    setIsCreating(true);
    try {
      const response = await fetch("/api/robomata/submissions", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await getAuthHeaders(signerAddress)) },
        body: JSON.stringify({
          operatorName: form.operatorName.trim(),
          facilityName: form.facilityName.trim(),
          asOfDate: form.asOfDate,
        }),
      });
      const payload = (await response.json()) as { submission?: FacilitySubmission; error?: string };

      if (!response.ok || !payload.submission) {
        notification.error(payload.error ?? "Failed to create submission.");
        return;
      }

      router.push(`/partner/submissions/${payload.submission.id}`);
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to create submission.");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <PartnerAccessGate>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Partner Workflow</p>
              <h1 className="mt-3 text-4xl font-black tracking-tight text-base-content sm:text-5xl">
                Borrowing base submissions
              </h1>
              <p className="mt-4 text-lg leading-relaxed text-base-content/70">
                Create a lender-ready facility submission from receivables and controlled evidence, then work exceptions
                through to a packet lenders can actually review.
              </p>
            </div>

            <div className="w-full max-w-xl rounded-[1.5rem] border border-base-300 bg-base-200/60 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-base-content/50">
                <PlusIcon className="h-4 w-4" />
                New submission
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <label className="form-control">
                  <span className="label-text">Operator name</span>
                  <input
                    className="input input-bordered"
                    value={form.operatorName}
                    onChange={event => setForm(current => ({ ...current, operatorName: event.target.value }))}
                    placeholder="MetroFleet Logistics"
                  />
                </label>
                <label className="form-control">
                  <span className="label-text">As-of date</span>
                  <input
                    type="date"
                    className="input input-bordered"
                    value={form.asOfDate}
                    onChange={event => setForm(current => ({ ...current, asOfDate: event.target.value }))}
                  />
                </label>
                <label className="form-control md:col-span-2">
                  <span className="label-text">Facility name</span>
                  <input
                    className="input input-bordered"
                    value={form.facilityName}
                    onChange={event => setForm(current => ({ ...current, facilityName: event.target.value }))}
                    placeholder="MetroFleet 2026 Fleet Receivables Facility"
                  />
                </label>
              </div>
              <button className="btn btn-primary mt-5 rounded-full" onClick={createSubmission} disabled={isCreating}>
                {isCreating ? "Creating..." : "Create submission"}
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Submission List</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">Open facility runs</h2>
            </div>
            <Link href="/robomata" className="btn btn-outline rounded-full">
              Open Robomata read-only view
            </Link>
          </div>

          {isLoading ? (
            <div className="py-16 text-center">
              <span className="loading loading-spinner loading-lg text-primary"></span>
            </div>
          ) : submissions.length === 0 ? (
            <div className="mt-8 rounded-[1.5rem] border border-dashed border-base-300 bg-base-200/40 p-8 text-center text-base-content/70">
              No submissions yet. Create the first facility run above.
            </div>
          ) : (
            <div className="mt-6 grid gap-4">
              {submissions.map(submission => (
                <Link
                  key={submission.id}
                  href={`/partner/submissions/${submission.id}`}
                  className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-5 transition hover:border-primary/40 hover:shadow-md"
                >
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <h3 className="text-xl font-bold text-base-content">{submission.facilityName}</h3>
                        <span className={`badge ${statusClass(submission.status)} capitalize`}>
                          {submission.status.replace(/_/g, " ")}
                        </span>
                      </div>
                      <p className="mt-2 text-base-content/70">{submission.operatorName}</p>
                    </div>
                    <div className="grid gap-2 text-sm text-base-content/70 md:text-right">
                      <div>As of {submission.asOfDate}</div>
                      <div>{submission.receivables.length} receivables</div>
                      <div>{submission.evidence.length} evidence packages</div>
                      <div>Updated {new Date(submission.updatedAt).toLocaleString()}</div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </PartnerAccessGate>
  );
};
