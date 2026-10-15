/**
 * In-shell 404 for an unknown hotel id. Uses the app-shell sizing convention
 * (see src/app/error.tsx) rather than the full-viewport marketing 404, because
 * the authenticated chrome is already supplied by the layout.
 */
import Link from "next/link";

import { HOTEL_NOT_FOUND_BODY, HOTEL_NOT_FOUND_TITLE } from "@/lib/ux02/copy";

export default function HotelNotFound() {
  return (
    <div className="ux-stack">
      <h1 className="ux-h1">{HOTEL_NOT_FOUND_TITLE}</h1>
      <p className="ux-lede">{HOTEL_NOT_FOUND_BODY}</p>
      <Link href="/app/discover" className="ux-btn ux-btn-primary">
        Back to Discover
      </Link>
    </div>
  );
}
