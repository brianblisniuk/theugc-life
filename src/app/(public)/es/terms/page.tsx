import type { Metadata } from "next";

import { LegalArticle } from "@/components/legal/legal-article";
import { ES_TERMS } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: { absolute: ES_TERMS.title },
  description: ES_TERMS.description,
  robots: { index: true, follow: true },
};

/** Public. Logged-out visitors and crawlers. */
export default function SpanishTermsPage() {
  return <LegalArticle document={ES_TERMS} languageSwitch={{ href: "/terms", label: "English" }} />;
}
