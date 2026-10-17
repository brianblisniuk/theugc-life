/**
 * Verbatim legal copy from the static theugc.life snapshots (13 Oct 2026).
 * Do not reword. Styling lives in the article component.
 */

export type Inline =
  string | { strong: string } | { code: string } | { link: string; href: string };

export type LegalBlock = { h2: string } | { p: Inline[] } | { ul: Inline[][] };

export interface LegalDocument {
  lang: "en" | "es";
  /** <title> from the snapshot, including the site suffix. */
  title: string;
  description: string;
  h1: string;
  updated: Inline[];
  blocks: LegalBlock[];
}

const DESCRIPTION = "TheUGC.life helps UGC creators find hotels for collaborations.";

const GOOGLE_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";
const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

export const EN_PRIVACY: LegalDocument = {
  lang: "en",
  title: "Privacy Policy · TheUGC.life",
  description: DESCRIPTION,
  h1: "Privacy Policy",
  updated: ["Last updated: October 13, 2026"],
  blocks: [
    {
      p: [
        'This policy explains how TheUGC.life ("TheUGC", "we", "us") collects, uses, stores, shares and deletes information when you use theugc.life and the TheUGC.life application (the "Service").',
      ],
    },
    { h2: "1. Who we are" },
    {
      p: [
        "The Service is operated by ",
        { strong: "Brian Blisniuk (sole proprietor / monotributista), CUIT 20-38617895-0" },
        ', with registered address at Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina (the "data controller"). Contact: ',
        { strong: "privacy@theugc.life" },
        ".",
      ],
    },
    {
      p: [
        "Argentine data protection law (Ley 25.326) applies. The Agencia de Acceso a la Información Pública (AAIP) is the control authority. The AAIP, in its capacity as Control Body of Law No. 25.326, has the power to deal with complaints and claims filed by those whose rights are affected by non-compliance with the regulations on personal data protection.",
      ],
    },
    { h2: "2. Information we collect" },
    {
      ul: [
        [
          { strong: "Account data:" },
          " name, email address, and authentication identifiers when you sign up (including via Google Sign-In).",
        ],
        [
          { strong: "Content you provide:" },
          " creator profile, pitches, notes, collaborations, deliverables and pipeline data you enter.",
        ],
        [
          { strong: "Gmail data (optional):" },
          " only if you explicitly connect your Gmail account (see Section 3).",
        ],
        [
          { strong: "Usage and technical data:" },
          " log data such as IP address, browser type, and pages visited, used for security and to operate the Service.",
        ],
        [
          { strong: "Billing data:" },
          " if paid plans are offered, payments are processed by a payment provider; we do not store full card numbers.",
        ],
      ],
    },
    { h2: "3. Gmail data and Google user data" },
    {
      p: [
        "Connecting Gmail is optional. If you connect it, we request ",
        { strong: "read-only" },
        " access (",
        { code: "https://www.googleapis.com/auth/gmail.readonly" },
        "). We never send, modify or delete email on your behalf.",
      ],
    },
    {
      p: [
        { strong: "How we use it:" },
        " solely to provide a user-facing feature: detecting emails related to hotel collaborations (for example, replies from hotels to your pitches) and showing them, with relevant details such as sender, subject, date and status, in your TheUGC.life pipeline. Messages not related to hotel collaborations are not stored.",
      ],
    },
    {
      p: [
        { strong: "Limited Use." },
        " TheUGC.life's use and transfer to any other app of information received from Google APIs will adhere to the ",
        { link: "Google API Services User Data Policy", href: GOOGLE_POLICY },
        ", including the Limited Use requirements. Specifically:",
      ],
    },
    {
      ul: [
        [
          "We use Gmail data only to provide and improve the user-facing collaboration-detection feature described above.",
        ],
        [
          "We do ",
          { strong: "not" },
          " transfer Gmail data to third parties, except as necessary to provide or improve that feature (e.g., our hosting and database subprocessors listed below), to comply with applicable law, or as part of a merger, acquisition or sale of assets with notice to you.",
        ],
        [
          "We do ",
          { strong: "not" },
          " use Gmail data for serving advertisements, including retargeting, personalized or interest-based advertising.",
        ],
        ["We do ", { strong: "not" }, " sell Gmail data."],
        [
          "We do ",
          { strong: "not" },
          " use Gmail data to develop, improve or train generalized or non-personalized AI and/or machine-learning models.",
        ],
        [
          "No human reads your Gmail data unless (a) you give us affirmative consent for specific messages (e.g., a support request), (b) it is necessary for security purposes such as investigating abuse, (c) it is necessary to comply with applicable law, or (d) the data has been aggregated and anonymized and is used for internal operations.",
        ],
      ],
    },
    { h2: "4. How we use information" },
    {
      p: [
        "To provide, maintain and secure the Service; to show hotels and manage your pitches and pipeline; to respond to your requests; to process payments for paid plans; and to comply with legal obligations. We do not sell personal information.",
      ],
    },
    { h2: "5. Legal bases (EEA/UK users)" },
    {
      p: [
        "Performance of a contract (providing the Service), your consent (connecting Gmail; you can withdraw it at any time), legitimate interests (security, fraud prevention, improving the Service), and legal obligations.",
      ],
    },
    { h2: "6. Storage and security" },
    {
      p: [
        "Data is stored in a database hosted by Supabase in the European Union. Data is encrypted in transit (TLS) and at rest. OAuth tokens are stored encrypted and access is restricted to the minimum required personnel and systems.",
      ],
    },
    { h2: "7. Subprocessors" },
    {
      ul: [
        [{ strong: "Supabase Inc." }, ": database, authentication and storage (EU region)."],
        [{ strong: "Netlify, Inc." }, ": website and application hosting."],
        [
          { strong: "Google LLC" },
          ": Google Sign-In, Gmail API (only if you connect Gmail) and Maps.",
        ],
      ],
    },
    {
      p: [
        "If we add a payment or email-lookup provider, we will update this list before it processes your data.",
      ],
    },
    { h2: "8. Retention and deletion" },
    {
      ul: [
        [
          { strong: "Disconnecting Gmail:" },
          " you can disconnect Gmail at any time in the app settings or at ",
          { link: "Google Account permissions", href: GOOGLE_PERMISSIONS },
          ". When you disconnect in the app, we revoke our access token and delete stored Gmail-derived data and tokens within 30 days.",
        ],
        [
          { strong: "Account deletion:" },
          " you can delete your account in the app or by emailing privacy@theugc.life. We delete your personal data, including Gmail-derived data, within 30 days, except where retention is required by law (e.g., billing records).",
        ],
        [
          { strong: "Otherwise:" },
          " we keep account data while your account is active. Backups are overwritten on a rolling basis within 30 days of deletion.",
        ],
      ],
    },
    { h2: "9. Your rights" },
    {
      p: [
        "Depending on your location, you may have the right to access, correct, delete, export or restrict processing of your data, to object to processing, and to withdraw consent. Under Argentine Law 25.326 you may also exercise the rights of access, rectification, updating and deletion. To exercise them, email ",
        { strong: "privacy@theugc.life" },
        ". We will respond within 30 days. You may also complain to your local data protection authority, including the AAIP in Argentina.",
      ],
    },
    { h2: "10. International transfers" },
    {
      p: [
        "Some subprocessors may process data outside your country. Where required, transfers rely on appropriate safeguards such as the EU Standard Contractual Clauses.",
      ],
    },
    { h2: "11. Children" },
    {
      p: [
        "The Service is not directed to anyone under 16, and we do not knowingly collect their data.",
      ],
    },
    { h2: "12. Changes" },
    {
      p: [
        "We will post updates on this page and notify you of material changes by email or in the app.",
      ],
    },
    { h2: "13. Contact" },
    {
      p: [
        "Brian Blisniuk (sole proprietor / monotributista), CUIT 20-38617895-0, Argentina. Address: Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. Email: ",
        { strong: "privacy@theugc.life" },
        ".",
      ],
    },
  ],
};

export const EN_TERMS: LegalDocument = {
  lang: "en",
  title: "Terms of Service · TheUGC.life",
  description: DESCRIPTION,
  h1: "Terms of Service",
  updated: ["Last updated: October 13, 2026"],
  blocks: [
    {
      p: [
        'These Terms govern your use of theugc.life and the TheUGC.life application (the "Service"), provided by ',
        { strong: "Brian Blisniuk (sole proprietor / monotributista), CUIT 20-38617895-0" },
        ", Argentina (Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina).",
      ],
    },
    { h2: "1. Use of the Service" },
    {
      p: [
        "You must be at least 16 and able to form a binding contract. You are responsible for your account and for the content you submit, including pitches you send to hotels.",
      ],
    },
    { h2: "2. Acceptable use" },
    {
      p: [
        "Do not use the Service to send spam, harass anyone, violate laws or third-party rights, scrape the Service, or interfere with its security.",
      ],
    },
    { h2: "3. Hotel information" },
    {
      p: [
        "Hotel data comes from third-party sources and may be incomplete or inaccurate, including star ratings marked as provisional. We do not guarantee any collaboration will be accepted.",
      ],
    },
    { h2: "4. Plans and credits" },
    {
      p: [
        'Some features may require a paid plan or credits. Payments are not live yet. When they become available, paid plans and credits will follow the prices and conditions shown at the time of purchase. Unused purchased credits are refundable within 10 days of purchase under Argentine consumer law (derecho de arrepentimiento / Law 24.240). To exercise the cooling-off right ("botón de arrepentimiento"), contact ',
        { strong: "privacy@theugc.life" },
        ".",
      ],
    },
    { h2: "5. Third-party services" },
    {
      p: [
        "Connecting Gmail or other services is optional and also subject to those providers' terms. Our handling of that data is described in the ",
        { link: "Privacy Policy", href: "/privacy" },
        ".",
      ],
    },
    { h2: "6. Intellectual property" },
    {
      p: [
        "You keep ownership of your content and grant us a license to process it only to provide the Service. The Service and its software belong to the operator.",
      ],
    },
    { h2: "7. Disclaimers and liability" },
    {
      p: [
        'The Service is provided "as is". To the extent permitted by law, we are not liable for indirect or consequential damages, and our total liability is limited to the amount you paid us in the last 12 months. Nothing in these Terms limits rights that cannot be waived under Argentine consumer law.',
      ],
    },
    { h2: "8. Termination" },
    {
      p: [
        "You may stop using the Service and delete your account at any time. We may suspend accounts that violate these Terms. Personal data is deleted within 30 days as described in the Privacy Policy.",
      ],
    },
    { h2: "9. Governing law" },
    {
      p: [
        "These Terms are governed by the laws of the Argentine Republic. Any dispute shall be submitted to the ordinary courts of the City of Buenos Aires (Ciudad Autónoma de Buenos Aires), Argentina.",
      ],
    },
    { h2: "10. Contact" },
    {
      p: [
        "Brian Blisniuk (sole proprietor / monotributista), CUIT 20-38617895-0. Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. Email: privacy@theugc.life",
      ],
    },
  ],
};

export const ES_PRIVACY: LegalDocument = {
  lang: "es",
  title: "Política de privacidad · TheUGC.life",
  description: DESCRIPTION,
  h1: "Política de privacidad",
  updated: [
    "Última actualización: 13 de octubre de 2026. Esta es una traducción; si hay diferencias, prevalece la ",
    { link: "versión en inglés", href: "/privacy" },
    ".",
  ],
  blocks: [
    { h2: "1. Quiénes somos" },
    {
      p: [
        "El Servicio es operado por ",
        { strong: "Brian Blisniuk (monotributista / sole proprietor), CUIT 20-38617895-0" },
        ", con domicilio en Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. Contacto: ",
        { strong: "privacy@theugc.life" },
        ".",
      ],
    },
    {
      p: [
        "Se aplica la Ley argentina de protección de datos personales (Ley 25.326). La Agencia de Acceso a la Información Pública (AAIP) es la autoridad de control. La AAIP, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.",
      ],
    },
    { h2: "2. Datos que recopilamos" },
    {
      p: [
        "Datos de cuenta (nombre, email, identificadores de Google Sign-In), contenido que cargás (perfil, pitches, colaboraciones, pipeline), datos de Gmail solo si lo conectás, datos técnicos de uso para seguridad y, si hay planes pagos, datos de facturación procesados por el proveedor de pagos.",
      ],
    },
    { h2: "3. Datos de Gmail" },
    {
      p: [
        "Conectar Gmail es opcional y el acceso es de ",
        { strong: "solo lectura" },
        " (",
        { code: "gmail.readonly" },
        "). Nunca enviamos, modificamos ni borramos emails. Lo usamos únicamente para detectar emails de colaboraciones con hoteles y mostrarlos en tu pipeline. Los emails que no tienen que ver con colaboraciones no se guardan.",
      ],
    },
    {
      p: [
        "El uso y la transferencia de datos recibidos de las APIs de Google cumplen la ",
        { link: "Google API Services User Data Policy", href: GOOGLE_POLICY },
        ", incluidos los requisitos de Uso Limitado: no usamos los datos de Gmail para publicidad, no los vendemos, no los usamos para entrenar modelos de IA generalizados y nadie los lee salvo con tu consentimiento, por seguridad, por obligación legal o si están agregados y anonimizados. Solo se comparten con los subencargados necesarios para prestar la función.",
      ],
    },
    { h2: "4. Almacenamiento y seguridad" },
    {
      p: [
        "Los datos se guardan en Supabase, en la Unión Europea, cifrados en tránsito y en reposo. Los tokens OAuth se guardan cifrados.",
      ],
    },
    { h2: "5. Subencargados" },
    {
      p: ["Supabase (base de datos, UE), Netlify (hosting) y Google (Sign-In, Gmail API y Maps)."],
    },
    { h2: "6. Conservación y eliminación" },
    {
      p: [
        "Si desconectás Gmail, revocamos el token y borramos los datos derivados de Gmail en un plazo de 30 días. Si borrás tu cuenta o lo pedís a privacy@theugc.life, borramos tus datos en 30 días, salvo lo que la ley obligue a conservar. Las copias de seguridad se sobrescriben en un ciclo de 30 días.",
      ],
    },
    { h2: "7. Tus derechos" },
    {
      p: [
        "Podés pedir acceso, corrección, eliminación, portabilidad, restricción u oposición, y retirar el consentimiento, escribiendo a ",
        { strong: "privacy@theugc.life" },
        ". Bajo la Ley 25.326 también podés ejercer los derechos de acceso, rectificación, actualización y supresión. Respondemos en 30 días. También podés presentar un reclamo ante la AAIP u otra autoridad de protección de datos de tu jurisdicción.",
      ],
    },
    { h2: "8. Contacto" },
    {
      p: [
        "Brian Blisniuk (monotributista / sole proprietor), CUIT 20-38617895-0, Argentina. Domicilio: Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. privacy@theugc.life",
      ],
    },
  ],
};

export const ES_TERMS: LegalDocument = {
  lang: "es",
  title: "Términos · TheUGC.life",
  description: DESCRIPTION,
  h1: "Términos del servicio",
  updated: [
    "Última actualización: 13 de octubre de 2026. Prevalece la ",
    { link: "versión en inglés", href: "/terms" },
    ".",
  ],
  blocks: [
    {
      p: [
        "Estos Términos regulan el uso de TheUGC.life, prestado por ",
        { strong: "Brian Blisniuk (monotributista / sole proprietor), CUIT 20-38617895-0" },
        ", Argentina (Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina).",
      ],
    },
    { h2: "1. Uso" },
    {
      p: [
        "Debés tener al menos 16 años. Sos responsable de tu cuenta y del contenido que enviás, incluidos los pitches a hoteles.",
      ],
    },
    { h2: "2. Uso aceptable" },
    {
      p: [
        "No uses el Servicio para spam, acoso, actividades ilegales ni para extraer datos o vulnerar su seguridad.",
      ],
    },
    { h2: "3. Datos de hoteles" },
    {
      p: [
        "Vienen de terceros y pueden ser incompletos, incluidas estrellas provisionales. No garantizamos que se acepte ninguna colaboración.",
      ],
    },
    { h2: "4. Planes y créditos" },
    {
      p: [
        'Algunas funciones pueden requerir un plan pago o créditos. Los pagos todavía no están activos. Cuando estén disponibles, los planes pagos y créditos seguirán los precios y condiciones mostrados al momento de la compra. Los créditos comprados no utilizados son reembolsables dentro de los 10 días de la compra conforme a la ley argentina de defensa del consumidor (derecho de arrepentimiento / Ley 24.240). Para ejercer el derecho de arrepentimiento ("botón de arrepentimiento"), contactá a ',
        { strong: "privacy@theugc.life" },
        ".",
      ],
    },
    { h2: "5. Responsabilidad" },
    {
      p: [
        'El Servicio se ofrece "tal cual". Nuestra responsabilidad total se limita a lo que nos pagaste en los últimos 12 meses, en la medida que lo permita la ley. Nada en estos Términos limita derechos irrenunciables bajo la ley argentina de defensa del consumidor.',
      ],
    },
    { h2: "6. Ley aplicable" },
    {
      p: [
        "Estos Términos se rigen por las leyes de la República Argentina. Cualquier controversia se someterá a los tribunales ordinarios de la Ciudad Autónoma de Buenos Aires.",
      ],
    },
    { h2: "7. Contacto" },
    {
      p: [
        "Brian Blisniuk (monotributista / sole proprietor), CUIT 20-38617895-0. Manuel Ugarte 2035 8C, C1428, Ciudad Autónoma de Buenos Aires, Argentina. privacy@theugc.life",
      ],
    },
  ],
};
