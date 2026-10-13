/**
 * Creator-owned pitch templates (D110).
 *
 * Another creator's templates are not listed. Archiving does not delete a
 * draft that already used the template.
 */
import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { ArchivePitchTemplate, PitchTemplateForm } from "@/components/pitch/template-form";
import { PageHeader } from "@/components/shell/page-header";
import { requireUser } from "@/lib/auth/guards";
import { listOwnPitchTemplates } from "@/lib/pitch/queries";
import { listCrumbs } from "@/lib/shell/navigation";

export const metadata: Metadata = { title: "Pitch templates" };

export default async function PitchTemplatesPage() {
  await requireUser("/app/profile/pitches");
  const loaded = await listOwnPitchTemplates();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Pitch templates"
        crumbs={listCrumbs("Pitch templates", { href: "/app/profile", label: "Perfil" })}
        description="Templates you save are only yours. A blank {{token}} is omitted when a fact is missing. Nothing here sends mail."
      />
      {loaded.status === "error" ? (
        <EmptyState
          title="We couldn’t load your templates"
          description="Reload the page to try again."
        />
      ) : loaded.templates.length === 0 ? (
        <p className="text-sm text-muted">You don’t have a saved template yet.</p>
      ) : (
        <ul className="space-y-3">
          {loaded.templates.map((template) => (
            <li
              key={template.id}
              className="space-y-2 rounded-[var(--radius-app)] border border-border bg-surface p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-text">{template.name}</h2>
                  <p className="text-sm text-muted">{template.subject}</p>
                </div>
                <ArchivePitchTemplate templateId={template.id} />
              </div>
              <pre className="whitespace-pre-wrap text-sm text-text">{template.body}</pre>
            </li>
          ))}
        </ul>
      )}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-text">New template</h2>
        <PitchTemplateForm />
      </section>
    </div>
  );
}
