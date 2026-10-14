import "server-only";

import { createClient } from "@/lib/supabase/server";

export interface AbuseFlagRow {
  id: string;
  userId: string;
  hotelId: string | null;
  signal: string;
  createdAt: string;
}

export interface PoolAlertRow {
  monthStart: string;
  level: string;
  poolMicros: number;
  spentMicros: number;
}

export async function listAdminAbuseFlags(): Promise<AbuseFlagRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("read_admin_abuse_flags", { p_limit: 50 });
  if (error || !Array.isArray(data)) return [];
  const rows: AbuseFlagRow[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const record = row as {
      id?: unknown;
      user_id?: unknown;
      hotel_id?: unknown;
      signal?: unknown;
      created_at?: unknown;
    };
    if (typeof record.id !== "string" || typeof record.user_id !== "string") continue;
    if (typeof record.signal !== "string" || typeof record.created_at !== "string") continue;
    rows.push({
      id: record.id,
      userId: record.user_id,
      hotelId: typeof record.hotel_id === "string" ? record.hotel_id : null,
      signal: record.signal,
      createdAt: record.created_at,
    });
  }
  return rows;
}

export async function listAdminPoolAlerts(): Promise<PoolAlertRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("read_admin_ai_pool_alerts", { p_limit: 12 });
  if (error || !Array.isArray(data)) return [];
  const rows: PoolAlertRow[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const record = row as {
      month_start?: unknown;
      level?: unknown;
      pool_micros?: unknown;
      spent_micros?: unknown;
    };
    if (typeof record.month_start !== "string" || typeof record.level !== "string") continue;
    if (typeof record.pool_micros !== "number" || typeof record.spent_micros !== "number") continue;
    rows.push({
      monthStart: record.month_start,
      level: record.level,
      poolMicros: record.pool_micros,
      spentMicros: record.spent_micros,
    });
  }
  return rows;
}
