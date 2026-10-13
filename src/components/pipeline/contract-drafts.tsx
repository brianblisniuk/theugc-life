"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  deleteContractAction,
  generateContractAction,
  saveContractAction,
} from "@/lib/contracts/actions";
import {
  agreementExportText,
  contractKindLabel,
  NOT_LEGAL_ADVICE,
  type ContractDraft,
  type ContractKind,
} from "@/lib/contracts/text";

const fieldClass =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";
const labelClass = "block text-xs font-medium text-muted";

const KINDS: readonly { kind: ContractKind; label: string }[] = [
  { kind: "hotel_stay_barter", label: "Hotel stay / barter" },
  { kind: "paid", label: "Paid collaboration" },
  { kind: "usage_rights", label: "Usage rights" },
];

function outcomeText(result: string | null): string | null {
  if (!result) return null;
  if (result === "created" || result === "saved") return "Draft saved";
  if (result === "deleted") return "Draft deleted";
  if (result === "not_won") return "An agreement can be generated when this deal is won.";
  if (result === "not_found" || result === "collaboration_not_found") {
    return "This deal could not be found.";
  }
  if (result === "disclaimer_required") {
    return "Keep the sentence that says this template is not legal advice.";
  }
  if (result === "too_long") return "That draft is too long to save.";
  if (result === "invalid_input") return "Check the text and try again.";
  return "Could not save";
}

function printAgreement(text: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("title", "Agreement print");
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(
    "<!DOCTYPE html><html><head><title>Agreement</title></head><body><pre></pre></body></html>",
  );
  doc.close();
  const pre = doc.querySelector("pre");
  if (!pre) {
    frame.remove();
    return;
  }
  pre.textContent = text;
  pre.style.whiteSpace = "pre-wrap";
  pre.style.fontFamily = "Georgia, serif";
  win.focus();
  win.print();
  window.setTimeout(() => frame.remove(), 1000);
}

export function ContractDrafts({
  pipelineItemId,
  hotelId,
  drafts,
}: {
  pipelineItemId: string;
  hotelId: string;
  drafts: ContractDraft[];
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(drafts[0]?.id ?? null);
  const [title, setTitle] = useState(drafts[0]?.title ?? "");
  const [body, setBody] = useState(drafts[0]?.body ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selected = drafts.find((draft) => draft.id === selectedId) ?? drafts[0] ?? null;

  useEffect(() => {
    if (!selected) return;
    setTitle(selected.title);
    setBody(selected.body);
  }, [selected]);

  async function run(
    action: () => Promise<{ result: string; contractId?: string; title?: string; body?: string }>,
  ) {
    setPending(true);
    try {
      const outcome = await action();
      setMessage(outcomeText(outcome.result));
      if (outcome.result === "created" && outcome.contractId) {
        setSelectedId(outcome.contractId);
        if (outcome.title) setTitle(outcome.title);
        if (outcome.body) setBody(outcome.body);
      }
      if (outcome.result === "deleted") setSelectedId(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="space-y-1">
        <h5 className="text-sm font-semibold text-text">Collaboration agreement</h5>
        <p className="max-w-prose text-sm text-muted">{NOT_LEGAL_ADVICE}</p>
        <p className="max-w-prose text-sm text-muted">
          Generate a private draft from a template. It is filled only from facts already recorded on
          this deal. Anything missing stays marked to be filled in. Nothing is sent, and nothing is
          signed.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {KINDS.map((item) => (
          <button
            key={item.kind}
            type="button"
            disabled={pending}
            className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background disabled:opacity-60"
            onClick={() => {
              const formData = new FormData();
              formData.set("pipelineItemId", pipelineItemId);
              formData.set("hotelId", hotelId);
              formData.set("kind", item.kind);
              void run(() => generateContractAction(formData));
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {message ? (
        <p className="text-sm text-text" role="status">
          {message}
        </p>
      ) : null}

      {drafts.length === 0 ? (
        <p className="text-sm text-muted">No draft yet.</p>
      ) : selected ? (
        <form
          className="space-y-3"
          action={(formData) => {
            void run(() => saveContractAction(formData));
          }}
        >
          <input type="hidden" name="contractId" value={selected.id} />
          <input type="hidden" name="hotelId" value={hotelId} />
          <div className="space-y-1">
            <label className={labelClass} htmlFor="contract-draft">
              Saved drafts
            </label>
            <select
              id="contract-draft"
              className={fieldClass}
              value={selected.id}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {drafts.map((draft) => (
                <option key={draft.id} value={draft.id}>
                  {draft.title} · {contractKindLabel(draft.kind)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className={labelClass} htmlFor="contract-title">
              Title
            </label>
            <input
              id="contract-title"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={fieldClass}
              maxLength={200}
            />
          </div>
          <div className="space-y-1">
            <label className={labelClass} htmlFor="contract-body">
              Agreement
            </label>
            <textarea
              id="contract-body"
              name="body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={16}
              className={fieldClass}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
            >
              {pending ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background"
              onClick={() => {
                const text = agreementExportText(title, body);
                void navigator.clipboard.writeText(text).then(
                  () => {
                    setCopyNote("Copied");
                    window.setTimeout(() => setCopyNote(null), 2000);
                  },
                  () => setCopyNote("Could not copy"),
                );
              }}
            >
              Copy text
            </button>
            <button
              type="button"
              className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background"
              onClick={() => printAgreement(agreementExportText(title, body))}
            >
              Print or save as PDF
            </button>
            <button
              type="button"
              disabled={pending}
              className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background disabled:opacity-60"
              onClick={() => {
                const formData = new FormData();
                formData.set("contractId", selected.id);
                formData.set("hotelId", hotelId);
                void run(() => deleteContractAction(formData));
              }}
            >
              Delete draft
            </button>
          </div>
          {copyNote ? (
            <p className="text-sm text-text" role="status">
              {copyNote}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
