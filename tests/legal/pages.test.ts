/**
 * Public legal pages. Text is the 13 October 2026 static-site copy.
 * Routes stay outside the auth gate and outside the /p/ noindex branch.
 */
import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import PrivacyPage, { metadata as privacyMetadata } from "@/app/(public)/privacy/page";
import TermsPage, { metadata as termsMetadata } from "@/app/(public)/terms/page";
import SpanishPrivacyPage, {
  metadata as spanishPrivacyMetadata,
} from "@/app/(public)/es/privacy/page";
import SpanishTermsPage, { metadata as spanishTermsMetadata } from "@/app/(public)/es/terms/page";
import { isProtectedPath } from "@/lib/auth/routes";
import { htmlLangFromPath } from "@/lib/http/html-lang";
import { contentSecurityPolicy } from "@/lib/http/security-headers";
import type { Metadata } from "next";

const CSP_NONCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GOOGLE_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";
const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

function source(file: string): string {
  return readFileSync(file, "utf8");
}

function strip(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function articleBlocks(html: string): string[] {
  const article = html.match(/<article\b[^>]*>([\s\S]*)<\/article>/);
  if (!article) throw new Error("missing article");
  const blocks: string[] = [];
  const re = /<(h1|h2|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(article[1]!))) blocks.push(strip(match[2]!));
  return blocks;
}

function articleHrefs(html: string): string[] {
  const article = html.match(/<article\b[^>]*>([\s\S]*)<\/article>/);
  if (!article) throw new Error("missing article");
  return [...article[1]!.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
}

interface LegalCase {
  path: string;
  Page: ComponentType;
  metadata: Metadata;
  lang: "en" | "es";
  blocks: string[];
  hrefs: string[];
  switchHref: string;
}

const EN_PRIVACY_BLOCKS = [
  "Privacy Policy",
  "Last updated: October 13, 2026",
  'This policy explains how TheUGC.life ("TheUGC", "we", "us") collects, uses, stores, shares and deletes information when you use theugc.life and the TheUGC.life application (the "Service").',
  "1. Who we are",
  'The Service is operated by Brian Blisniuk (sole proprietor / monotributista), CUIT 20-38617895-0, with registered address at Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina (the "data controller"). Contact: privacy@theugc.life.',
  "Argentine data protection law (Ley 25.326) applies. The Agencia de Acceso a la Información Pública (AAIP) is the control authority. The AAIP, in its capacity as Control Body of Law No. 25.326, has the power to deal with complaints and claims filed by those whose rights are affected by non-compliance with the regulations on personal data protection.",
  "2. Information we collect",
  "Account data: name, email address, and authentication identifiers when you sign up (including via Google Sign-In).",
  "Content you provide: creator profile, pitches, notes, collaborations, deliverables and pipeline data you enter.",
  "Gmail data (optional): only if you explicitly connect your Gmail account (see Section 3).",
  "Usage and technical data: log data such as IP address, browser type, and pages visited, used for security and to operate the Service.",
  "Billing data: if paid plans are offered, payments are processed by a payment provider; we do not store full card numbers.",
  "3. Gmail data and Google user data",
  "Connecting Gmail is optional. If you connect it, we request read-only access (https://www.googleapis.com/auth/gmail.readonly). We never send, modify or delete email on your behalf.",
  "How we use it: solely to provide a user-facing feature: detecting emails related to hotel collaborations (for example, replies from hotels to your pitches) and showing them, with relevant details such as sender, subject, date and status, in your TheUGC.life pipeline. Messages not related to hotel collaborations are not stored.",
  "Limited Use. TheUGC.life's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements. Specifically:",
  "We use Gmail data only to provide and improve the user-facing collaboration-detection feature described above.",
  "We do not transfer Gmail data to third parties, except as necessary to provide or improve that feature (e.g., our hosting and database subprocessors listed below), to comply with applicable law, or as part of a merger, acquisition or sale of assets with notice to you.",
  "We do not use Gmail data for serving advertisements, including retargeting, personalized or interest-based advertising.",
  "We do not sell Gmail data.",
  "We do not use Gmail data to develop, improve or train generalized or non-personalized AI and/or machine-learning models.",
  "No human reads your Gmail data unless (a) you give us affirmative consent for specific messages (e.g., a support request), (b) it is necessary for security purposes such as investigating abuse, (c) it is necessary to comply with applicable law, or (d) the data has been aggregated and anonymized and is used for internal operations.",
  "4. How we use information",
  "To provide, maintain and secure the Service; to show hotels and manage your pitches and pipeline; to respond to your requests; to process payments for paid plans; and to comply with legal obligations. We do not sell personal information.",
  "5. Legal bases (EEA/UK users)",
  "Performance of a contract (providing the Service), your consent (connecting Gmail; you can withdraw it at any time), legitimate interests (security, fraud prevention, improving the Service), and legal obligations.",
  "6. Storage and security",
  "Data is stored in a database hosted by Supabase in the European Union. Data is encrypted in transit (TLS) and at rest. OAuth tokens are stored encrypted and access is restricted to the minimum required personnel and systems.",
  "7. Subprocessors",
  "Supabase Inc.: database, authentication and storage (EU region).",
  "Netlify, Inc.: website and application hosting.",
  "Google LLC: Google Sign-In, Gmail API (only if you connect Gmail) and Maps.",
  "If we add a payment or email-lookup provider, we will update this list before it processes your data.",
  "8. Retention and deletion",
  "Disconnecting Gmail: you can disconnect Gmail at any time in the app settings or at Google Account permissions. When you disconnect in the app, we revoke our access token and delete stored Gmail-derived data and tokens within 30 days.",
  "Account deletion: you can delete your account in the app or by emailing privacy@theugc.life. We delete your personal data, including Gmail-derived data, within 30 days, except where retention is required by law (e.g., billing records).",
  "Otherwise: we keep account data while your account is active. Backups are overwritten on a rolling basis within 30 days of deletion.",
  "9. Your rights",
  "Depending on your location, you may have the right to access, correct, delete, export or restrict processing of your data, to object to processing, and to withdraw consent. Under Argentine Law 25.326 you may also exercise the rights of access, rectification, updating and deletion. To exercise them, email privacy@theugc.life. We will respond within 30 days. You may also complain to your local data protection authority, including the AAIP in Argentina.",
  "10. International transfers",
  "Some subprocessors may process data outside your country. Where required, transfers rely on appropriate safeguards such as the EU Standard Contractual Clauses.",
  "11. Children",
  "The Service is not directed to anyone under 16, and we do not knowingly collect their data.",
  "12. Changes",
  "We will post updates on this page and notify you of material changes by email or in the app.",
  "13. Contact",
  "Brian Blisniuk (sole proprietor / monotributista), CUIT 20-38617895-0, Argentina. Address: Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. Email: privacy@theugc.life.",
];

const EN_TERMS_BLOCKS = [
  "Terms of Service",
  "Last updated: October 13, 2026",
  'These Terms govern your use of theugc.life and the TheUGC.life application (the "Service"), provided by Brian Blisniuk (sole proprietor / monotributista), CUIT 20-38617895-0, Argentina (Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina).',
  "1. Use of the Service",
  "You must be at least 16 and able to form a binding contract. You are responsible for your account and for the content you submit, including pitches you send to hotels.",
  "2. Acceptable use",
  "Do not use the Service to send spam, harass anyone, violate laws or third-party rights, scrape the Service, or interfere with its security.",
  "3. Hotel information",
  "Hotel data comes from third-party sources and may be incomplete or inaccurate, including star ratings marked as provisional. We do not guarantee any collaboration will be accepted.",
  "4. Plans and credits",
  'Some features may require a paid plan or credits. Payments are not live yet. When they become available, paid plans and credits will follow the prices and conditions shown at the time of purchase. Unused purchased credits are refundable within 10 days of purchase under Argentine consumer law (derecho de arrepentimiento / Law 24.240). To exercise the cooling-off right ("botón de arrepentimiento"), contact privacy@theugc.life.',
  "5. Third-party services",
  "Connecting Gmail or other services is optional and also subject to those providers' terms. Our handling of that data is described in the Privacy Policy.",
  "6. Intellectual property",
  "You keep ownership of your content and grant us a license to process it only to provide the Service. The Service and its software belong to the operator.",
  "7. Disclaimers and liability",
  'The Service is provided "as is". To the extent permitted by law, we are not liable for indirect or consequential damages, and our total liability is limited to the amount you paid us in the last 12 months. Nothing in these Terms limits rights that cannot be waived under Argentine consumer law.',
  "8. Termination",
  "You may stop using the Service and delete your account at any time. We may suspend accounts that violate these Terms. Personal data is deleted within 30 days as described in the Privacy Policy.",
  "9. Governing law",
  "These Terms are governed by the laws of the Argentine Republic. Any dispute shall be submitted to the ordinary courts of the City of Buenos Aires (Ciudad Autónoma de Buenos Aires), Argentina.",
  "10. Contact",
  "Brian Blisniuk (sole proprietor / monotributista), CUIT 20-38617895-0. Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. Email: privacy@theugc.life",
];

const ES_PRIVACY_BLOCKS = [
  "Política de privacidad",
  "Última actualización: 13 de octubre de 2026. Esta es una traducción; si hay diferencias, prevalece la versión en inglés.",
  "1. Quiénes somos",
  "El Servicio es operado por Brian Blisniuk (monotributista / sole proprietor), CUIT 20-38617895-0, con domicilio en Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. Contacto: privacy@theugc.life.",
  "Se aplica la Ley argentina de protección de datos personales (Ley 25.326). La Agencia de Acceso a la Información Pública (AAIP) es la autoridad de control. La AAIP, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.",
  "2. Datos que recopilamos",
  "Datos de cuenta (nombre, email, identificadores de Google Sign-In), contenido que cargás (perfil, pitches, colaboraciones, pipeline), datos de Gmail solo si lo conectás, datos técnicos de uso para seguridad y, si hay planes pagos, datos de facturación procesados por el proveedor de pagos.",
  "3. Datos de Gmail",
  "Conectar Gmail es opcional y el acceso es de solo lectura (gmail.readonly). Nunca enviamos, modificamos ni borramos emails. Lo usamos únicamente para detectar emails de colaboraciones con hoteles y mostrarlos en tu pipeline. Los emails que no tienen que ver con colaboraciones no se guardan.",
  "El uso y la transferencia de datos recibidos de las APIs de Google cumplen la Google API Services User Data Policy, incluidos los requisitos de Uso Limitado: no usamos los datos de Gmail para publicidad, no los vendemos, no los usamos para entrenar modelos de IA generalizados y nadie los lee salvo con tu consentimiento, por seguridad, por obligación legal o si están agregados y anonimizados. Solo se comparten con los subencargados necesarios para prestar la función.",
  "4. Almacenamiento y seguridad",
  "Los datos se guardan en Supabase, en la Unión Europea, cifrados en tránsito y en reposo. Los tokens OAuth se guardan cifrados.",
  "5. Subencargados",
  "Supabase (base de datos, UE), Netlify (hosting) y Google (Sign-In, Gmail API y Maps).",
  "6. Conservación y eliminación",
  "Si desconectás Gmail, revocamos el token y borramos los datos derivados de Gmail en un plazo de 30 días. Si borrás tu cuenta o lo pedís a privacy@theugc.life, borramos tus datos en 30 días, salvo lo que la ley obligue a conservar. Las copias de seguridad se sobrescriben en un ciclo de 30 días.",
  "7. Tus derechos",
  "Podés pedir acceso, corrección, eliminación, portabilidad, restricción u oposición, y retirar el consentimiento, escribiendo a privacy@theugc.life. Bajo la Ley 25.326 también podés ejercer los derechos de acceso, rectificación, actualización y supresión. Respondemos en 30 días. También podés presentar un reclamo ante la AAIP u otra autoridad de protección de datos de tu jurisdicción.",
  "8. Contacto",
  "Brian Blisniuk (monotributista / sole proprietor), CUIT 20-38617895-0, Argentina. Domicilio: Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. privacy@theugc.life",
];

const ES_TERMS_BLOCKS = [
  "Términos del servicio",
  "Última actualización: 13 de octubre de 2026. Prevalece la versión en inglés.",
  "Estos Términos regulan el uso de TheUGC.life, prestado por Brian Blisniuk (monotributista / sole proprietor), CUIT 20-38617895-0, Argentina (Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina).",
  "1. Uso",
  "Debés tener al menos 16 años. Sos responsable de tu cuenta y del contenido que enviás, incluidos los pitches a hoteles.",
  "2. Uso aceptable",
  "No uses el Servicio para spam, acoso, actividades ilegales ni para extraer datos o vulnerar su seguridad.",
  "3. Datos de hoteles",
  "Vienen de terceros y pueden ser incompletos, incluidas estrellas provisionales. No garantizamos que se acepte ninguna colaboración.",
  "4. Planes y créditos",
  'Algunas funciones pueden requerir un plan pago o créditos. Los pagos todavía no están activos. Cuando estén disponibles, los planes pagos y créditos seguirán los precios y condiciones mostrados al momento de la compra. Los créditos comprados no utilizados son reembolsables dentro de los 10 días de la compra conforme a la ley argentina de defensa del consumidor (derecho de arrepentimiento / Ley 24.240). Para ejercer el derecho de arrepentimiento ("botón de arrepentimiento"), contactá a privacy@theugc.life.',
  "5. Responsabilidad",
  'El Servicio se ofrece "tal cual". Nuestra responsabilidad total se limita a lo que nos pagaste en los últimos 12 meses, en la medida que lo permita la ley. Nada en estos Términos limita derechos irrenunciables bajo la ley argentina de defensa del consumidor.',
  "6. Ley aplicable",
  "Estos Términos se rigen por las leyes de la República Argentina. Cualquier controversia se someterá a los tribunales ordinarios de la Ciudad Autónoma de Buenos Aires.",
  "7. Contacto",
  "Brian Blisniuk (monotributista / sole proprietor), CUIT 20-38617895-0. Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. privacy@theugc.life",
];

const CASES: LegalCase[] = [
  {
    path: "/privacy",
    Page: PrivacyPage,
    metadata: privacyMetadata,
    lang: "en",
    blocks: EN_PRIVACY_BLOCKS,
    hrefs: [GOOGLE_POLICY, GOOGLE_PERMISSIONS],
    switchHref: "/es/privacy",
  },
  {
    path: "/terms",
    Page: TermsPage,
    metadata: termsMetadata,
    lang: "en",
    blocks: EN_TERMS_BLOCKS,
    hrefs: ["/privacy"],
    switchHref: "/es/terms",
  },
  {
    path: "/es/privacy",
    Page: SpanishPrivacyPage,
    metadata: spanishPrivacyMetadata,
    lang: "es",
    blocks: ES_PRIVACY_BLOCKS,
    hrefs: ["/privacy", GOOGLE_POLICY],
    switchHref: "/privacy",
  },
  {
    path: "/es/terms",
    Page: SpanishTermsPage,
    metadata: spanishTermsMetadata,
    lang: "es",
    blocks: ES_TERMS_BLOCKS,
    hrefs: ["/terms"],
    switchHref: "/terms",
  },
];

describe("public legal pages", () => {
  it.each(CASES)("$path renders the snapshot headings and last-updated line", (legal) => {
    const html = renderToStaticMarkup(createElement(legal.Page));
    const blocks = articleBlocks(html);
    expect(blocks).toEqual(legal.blocks);
    expect(blocks[0]).toBe(legal.blocks[0]);
    expect(blocks[1]).toBe(legal.blocks[1]);
    expect(blocks.filter((_, index) => legal.blocks[index]?.match(/^\d+\. /))).toEqual(
      legal.blocks.filter((block) => /^\d+\. /.test(block)),
    );
    expect(html).toContain(`lang="${legal.lang}"`);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("noindex");
    expect(articleHrefs(html)).toEqual(legal.hrefs);
    expect(html).toContain(`href="${legal.switchHref}"`);
    expect(isProtectedPath(legal.path)).toBe(false);
    expect(legal.metadata.robots).toEqual({ index: true, follow: true });
    const robots = JSON.stringify(legal.metadata.robots);
    expect(robots).not.toContain("noindex");
  });

  it("links Privacy and Terms from the landing page and the public footer", () => {
    const landing = source("src/app/(public)/page.tsx");
    const layout = source("src/app/(public)/layout.tsx");
    for (const file of [landing, layout]) {
      expect(file).toContain('href="/privacy"');
      expect(file).toContain('href="/terms"');
      expect(file).toContain("Privacy");
      expect(file).toContain("Terms");
    }
    const html = renderToStaticMarkup(createElement(PrivacyPage));
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Last updated: October 13, 2026");
  });

  it("does not protect legal routes or mark them noindex in middleware", () => {
    for (const path of ["/privacy", "/terms", "/es/privacy", "/es/terms"]) {
      expect(isProtectedPath(path)).toBe(false);
    }
    const middleware = source("src/lib/supabase/middleware.ts");
    expect(middleware).toContain("isProtectedPath");
    let from = 0;
    while (from < middleware.length) {
      const at = middleware.indexOf("noindex", from);
      if (at === -1) break;
      expect(middleware.slice(Math.max(0, at - 500), at)).toContain('"/p/"');
      from = at + "noindex".length;
    }
    expect(middleware).not.toContain('"/privacy"');
    expect(middleware).not.toContain('"/terms"');
  });

  it("keeps the content security policy unchanged for legal links", () => {
    const policy = contentSecurityPolicy("https://example.supabase.co", CSP_NONCE);
    expect(policy).toContain(`'nonce-${CSP_NONCE}'`);
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain("developers.google.com");
    expect(policy).not.toContain("myaccount.google.com");
    expect(policy).not.toContain("unsafe-inline' https://");
    const script = policy.split(";").find((part) => part.trim().startsWith("script-src"));
    expect(script).not.toContain("'unsafe-inline'");
    expect(htmlLangFromPath("/es/privacy")).toBe("es");
    expect(htmlLangFromPath("/es/terms")).toBe("es");
    expect(htmlLangFromPath("/privacy")).toBe("en");
    expect(htmlLangFromPath("/terms")).toBe("en");
    expect(htmlLangFromPath("/")).toBe("en");
  });
});
