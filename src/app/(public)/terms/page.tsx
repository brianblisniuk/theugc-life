import type { Metadata } from "next";

import { LegalArticle } from "@/components/legal/legal-article";
import { EN_TERMS } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: { absolute: EN_TERMS.title },
  description: EN_TERMS.description,
  robots: { index: true, follow: true },
};

/** Public. Logged-out visitors and crawlers. */
export default function TermsPage() {
  return (
    <LegalArticle document={EN_TERMS} languageSwitch={{ href: "/es/terms", label: "Español" }} />
  );
}
