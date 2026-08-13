/**
 * "Your Activity" — the creator's private relationship to a hotel (PRD §7.3).
 *
 * Sprint 2A reserves this section visually but does NOT mutate the pipeline.
 * Saving must be transactional and enforce free-plan limits (FREE_LIMITS in
 * lib/config, PERMISSIONS.md §14); implementing a naive insert here would
 * bypass that, so the CTA is deliberately a disabled preview until Sprint 2B
 * delivers Save → Pipeline properly.
 */
export function ActivityPanel() {
  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-text">Your private workspace</h3>
        <p className="max-w-prose text-sm text-muted">
          Your notes, outreach status, and follow-up reminders for this hotel will live here. Only
          you can see them.
        </p>
      </div>

      <button
        type="button"
        disabled
        aria-describedby="save-pipeline-hint"
        className="inline-flex cursor-not-allowed rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm font-medium text-muted"
      >
        Save to Pipeline
      </button>
      <p id="save-pipeline-hint" className="text-xs text-muted">
        Saving to your pipeline arrives in the next release.
      </p>
    </div>
  );
}
