/** Sanitized unlock result. `email` is null unless this user owns the hotel. */
export type UnlockActionResult =
  | {
      status: "unlocked" | "already_unlocked";
      email: string | null;
      balance: number | null;
    }
  | {
      status: "insufficient_credits" | "not_found";
      email: null;
      balance: number | null;
    }
  | { status: "unauthenticated" | "error" | "hotel_missing"; email: null };

export type ReportActionResult = { status: "reported" | "unauthenticated" | "error" };

export type AdminGrantResult = {
  status: "granted" | "unauthenticated" | "forbidden" | "error" | "user_missing";
  balance: number | null;
};

export type ReviewReportResult = {
  status: "accepted" | "rejected" | "unauthenticated" | "forbidden" | "error" | "not_found";
};

export interface PendingContactReport {
  id: string;
  userId: string;
  hotelId: string;
  reason: string;
}
