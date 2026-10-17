import type { Metadata } from "next";

import { LegalArticle } from "@/components/legal/legal-article";
import { ES_PRIVACY } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: { absolute: ES_PRIVACY.title },
  description: ES_PRIVACY.description,
  robots: { index: true, follow: true },
};

/** Public. Logged-out visitors and crawlers. */
export default function SpanishPrivacyPage() {
  return (
    <LegalArticle document={ES_PRIVACY} languageSwitch={{ href: "/privacy", label: "English" }} />
  );
}
