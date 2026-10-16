import { SourceBadge } from "@/components/ui/badge";
import { requireRole } from "@/lib/auth/guards";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import {
  DisconnectedEmailState,
  EmptyState,
  ErrorState,
  InsufficientCreditsState,
  InsufficientDataState,
  LoadingState,
  LockedState,
} from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";

export const metadata = { title: "UI guide" };

/**
 * Internal specimen for the Midnight components. Not a product screen.
 * Contract Review is intentionally absent.
 */
export default async function DesignGuidePage() {
  await requireRole(["admin", "editor"], "/app/design");
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-accent">Midnight</p>
        <h1 className="text-3xl font-extrabold tracking-tight">UI guide</h1>
        <p className="max-w-prose text-sm text-muted">
          Buttons, fields, chips, cards, tables, badges, tabs, dialogs, and the required states.
          Lime is the primary action. It is not a success color.
        </p>
      </header>

      <Card title="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button variant="primary">Primary action</Button>
          <Button>Secondary</Button>
          <Button variant="dark">Dark</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </div>
      </Card>

      <Card title="Fields">
        <div className="grid gap-3 md:grid-cols-2">
          <TextField id="guide-name" label="Hotel" placeholder="Search hotels" />
          <SelectField id="guide-tone" label="Tone" defaultValue="warm">
            <option value="warm">Warm</option>
            <option value="direct">Direct</option>
          </SelectField>
          <TextAreaField
            id="guide-note"
            label="Note"
            rows={3}
            placeholder="A draft is not a sent pitch"
          />
        </div>
      </Card>

      <Card title="Chips and tabs">
        <div className="mb-3 flex flex-wrap gap-2">
          <Chip pressed>Board</Chip>
          <Chip>List</Chip>
          <Chip>Timeline</Chip>
        </div>
        <Tabs
          label="Pipeline views"
          tabs={[
            { id: "board", label: "Board", panel: <p>One opportunity per card.</p> },
            { id: "list", label: "List", panel: <p>The same records, as a list.</p> },
          ]}
        />
      </Card>

      <Card title="Table and source">
        <DataTable
          caption="Sample activity"
          columns={["Event", "Source"]}
          rows={[
            ["Reply received", <SourceBadge key="g" source="gmail" />],
            ["Compensation noted", <SourceBadge key="m" source="manual" />],
          ]}
        />
      </Card>

      <Card title="States">
        <div className="grid gap-3">
          <EmptyState
            title="Nothing here yet"
            description="Save a hotel when you find one worth pursuing."
          />
          <LoadingState />
          <ErrorState title="Could not load" description="Retry. This is not an empty list." />
          <LockedState />
          <InsufficientCreditsState />
          <DisconnectedEmailState />
          <InsufficientDataState />
        </div>
      </Card>

      <Card title="Dialog">
        <Modal title="Confirm" trigger="Open dialog">
          <p>Closing this dialog does not change your credits or your pipeline.</p>
        </Modal>
      </Card>
    </div>
  );
}
