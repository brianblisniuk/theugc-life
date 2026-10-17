import type { Metadata } from "next";

import { LegalArticle } from "@/components/legal/legal-article";
import { EN_PRIVACY } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: { absolute: EN_PRIVACY.title },
  description: EN_PRIVACY.description,
  robots: { index: true, follow: true },
};

/** Public. Logged-out visitors and crawlers. */
export default function PrivacyPage() {
  return (
    <LegalArticle
      document={EN_PRIVACY}
      languageSwitch={{ href: "/es/privacy", label: "Español" }}
    />
  );
}
