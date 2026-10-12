/**
 * B08 constants. The 15-minute due interval is owned by migration 0047
 * (`interval '15 minutes'`). This module does not accept a caller-supplied
 * cadence, scope, or acquisition strategy.
 */

export const B08_ACQUISITION_STRATEGY = "sent_rooted_threads_v1";

/** Published Gmail quota costs. Estimates, not a bill. */
export const HISTORY_LIST_QUOTA_UNITS = 2;
export const PROFILE_GET_QUOTA_UNITS = 1;

export const B08_MAX_PROVIDER_ATTEMPTS = 5;
export const B08_DEFAULT_LEASE_SECONDS = 120;
export const B08_DEFAULT_MAX_STEPS = 80;

/** Documented cadence. The database due-time is the authority. */
export const B08_SYNC_INTERVAL_MINUTES = 15;
