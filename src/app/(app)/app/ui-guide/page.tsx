import type { Metadata } from "next";

import { Button } from "@/components/design-system/button";
import { Callout } from "@/components/design-system/callout";
import { Chip } from "@/components/design-system/chip";
import { ContextStrip } from "@/components/design-system/context-strip";
import { DataTable } from "@/components/design-system/data-table";
import { MetricRing } from "@/components/design-system/metric-ring";
import { Panel } from "@/components/design-system/panel";
import { Pill } from "@/components/design-system/pill";
import { ProvenanceBadge } from "@/components/design-system/provenance-badge";
import { Skeleton } from "@/components/design-system/skeleton";
import { Stat } from "@/components/design-system/stat";
import { StateMessage } from "@/components/design-system/state-message";
import { requireRole } from "@/lib/auth/guards";
import { V12_TOKENS } from "@/lib/design-system/tokens";
import { MANDATORY_STATES, PROVENANCE_BADGES } from "@/lib/design-system/states";

export const metadata: Metadata = {
  title: "UI guide",
  robots: { index: false, follow: false },
};

const SWATCHES = [
  { name: "Sidebar", hex: V12_TOKENS.nav, note: "Dark navigation surface" },
  { name: "Action", hex: V12_TOKENS.lime, note: "Primary action fill" },
  { name: "Canvas", hex: V12_TOKENS.bg, note: "Content background" },
  { name: "Paper", hex: V12_TOKENS.paper, note: "Cards and inputs" },
  { name: "Ink", hex: V12_TOKENS.ink, note: "Primary text" },
  { name: "Muted", hex: V12_TOKENS.muted, note: "Secondary text" },
] as const;

/**
 * Internal V12.1 guide. Staff only. Sample labels are not hotel records.
 * This page does not unlock a contact, charge a credit, or send mail.
 * The route is `/app/ui-guide` because a leading underscore is a private
 * folder in the App Router and would not be served.
 */
export default async function DesignGuidePage() {
  await requireRole(["admin", "editor"], "/app/ui-guide");

  return (
    <div className="v12-stack" style={{ gap: 28 }}>
      <header>
        <div className="v12-eyebrow">UI GUIDE</div>
        <h1 className="v12-h1">One design language.</h1>
        <p style={{ marginTop: 8, maxWidth: 680 }}>
          Light canvas, dark sidebar, lime action. These are the shared pieces later screens use.
          Nothing here is a live hotel, a charge, or a sent message.
        </p>
      </header>

      <Callout tone="neutral" title="Sample only.">
        The rows below are labels for the guide. They are not creator data.
      </Callout>

      <section className="v12-grid v12-grid-3">
        <Panel>
          <div className="v12-eyebrow">COLORS</div>
          <div className="v12-stack">
            {SWATCHES.map((swatch) => (
              <div className="v12-row" key={swatch.hex}>
                <span className="v12-swatch" style={{ background: swatch.hex }} />
                <div>
                  <strong>{swatch.hex.toUpperCase()}</strong>
                  <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>{swatch.note}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel>
          <div className="v12-eyebrow">TYPE</div>
          <h2 style={{ fontSize: 29, letterSpacing: "-0.7px" }}>Archivo Bold</h2>
          <h3 style={{ marginTop: 12 }}>Interface subheading</h3>
          <p style={{ marginTop: 8 }}>Default explanatory copy stays at 14px.</p>
          <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
            Captions that carry meaning stay at 12px or larger.
          </p>
        </Panel>
        <Panel>
          <div className="v12-eyebrow">ACTIONS</div>
          <div className="v12-actions">
            <Button type="button" tone="primary">
              One primary action
            </Button>
            <Button type="button">Secondary action</Button>
            <Button type="button" tone="ghost">
              Other action
            </Button>
            <Button type="button" tone="dark" small>
              Dark
            </Button>
            <Button type="button" disabled>
              Disabled
            </Button>
          </div>
        </Panel>
      </section>

      <section className="v12-grid v12-grid-2">
        <Stat label="Open items" value="3" note="A count, not a score" />
        <Stat label="Evidence" value="—" note="Insufficient data is not zero" />
      </section>

      <ContextStrip
        title="Context stays with the task"
        detail="Hotel, trip, and opportunity stay visible when the screen changes."
        aside={<Pill tone="green">In context</Pill>}
      />

      <div className="v12-chips">
        <Chip pressed>All</Chip>
        <Chip>Needs a reply</Chip>
        <Chip>Manual</Chip>
      </div>

      <div className="v12-actions">
        <Pill>Neutral</Pill>
        <Pill tone="green">Verified</Pill>
        <Pill tone="amber">Manual</Pill>
        <Pill tone="blue">Pending</Pill>
        <Pill tone="gray">Sample</Pill>
        <Pill tone="red">Failed</Pill>
        <Pill tone="lime">Action tint</Pill>
      </div>

      <Panel>
        <div className="v12-eyebrow">PROVENANCE</div>
        <div className="v12-actions" style={{ marginTop: 12 }}>
          {PROVENANCE_BADGES.map((badge) => (
            <ProvenanceBadge key={badge.id} id={badge.id} />
          ))}
        </div>
      </Panel>

      <div className="v12-grid v12-grid-2">
        <MetricRing model={{ sufficient: true, value: 42, label: "Sample figure" }} />
        <MetricRing model={{ sufficient: false, value: 0, label: "Missing evidence" }} />
      </div>

      <Panel>
        <DataTable
          caption="Sample states. Not live records."
          columns={[
            { id: "hotel", header: "Hotel" },
            { id: "state", header: "State" },
            { id: "source", header: "Provenance" },
          ]}
          rows={[
            ["Northwind sample", "Saved", <ProvenanceBadge key="s" id="sample" />],
            ["Harbor sample", "Verification pending", <ProvenanceBadge key="p" id="pending" />],
          ]}
        />
      </Panel>

      <section>
        <h2 style={{ fontSize: 21, letterSpacing: "-0.4px", marginBottom: 12 }}>States</h2>
        <div className="v12-grid v12-grid-2">
          {MANDATORY_STATES.map((state) => (
            <StateMessage key={state.id} id={state.id} />
          ))}
        </div>
      </section>

      <Skeleton />

      <Callout title="Saved is not sent.">
        A draft can be saved without becoming a sent message.
      </Callout>
      <Callout tone="warn" title="Check the source.">
        A manual note is not a Gmail event.
      </Callout>
    </div>
  );
}
