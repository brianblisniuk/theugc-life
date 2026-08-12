import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

export default function AdminHomePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-text">Admin</h1>
      <p className="text-sm text-muted">
        Internal operations. Access is restricted to admin and editor roles, enforced server-side.
      </p>
      <EmptyState
        title="Admin workflows arrive in Sprint 1"
        description="Hotel/contact management, verification history, flags, users, entitlements, and database health build on this foundation."
      />
    </div>
  );
}
