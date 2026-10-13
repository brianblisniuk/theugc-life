/**
 * Closed-taxonomy aliases for the hotel catalog importer.
 *
 * Research sheets use free text ("Marketing", "PR & Communications", "reported",
 * "corporate", Spanish labels, legacy claim names). Staging stores only the
 * canonical enums from HOTEL_DATA_CONTRACT. An unrecognized non-empty token is
 * never inserted as itself (that would fail the database checks or publish a
 * value the product does not have). It falls back to other/unknown/unverified
 * and is flagged unmapped so the rejection report can count it.
 *
 * Aliases are exact after case/diacritic/punctuation folding, then a longest
 * whole-phrase match. Two different targets at the same length are unmapped
 * rather than guessed.
 */
import {
  CLAIM_TYPES,
  CONTACT_SCOPES,
  DEPARTMENTS,
  ORG_TYPES,
  type ClaimType,
  type ContactRecord,
  type ContactScope,
  type Department,
  type OrgType,
} from "./contract";
import { foldForMatch, normalizeString } from "./normalize";

export const DEPARTMENT_ALIASES: Record<string, Department> = {
  marketing: "marketing",
  mkt: "marketing",
  mktg: "marketing",
  mercadotecnia: "marketing",
  comercializacion: "marketing",
  "digital marketing": "social_media",
  "marketing digital": "social_media",
  "social media": "social_media",
  social: "social_media",
  influencer: "social_media",
  influencers: "social_media",
  "influencer marketing": "social_media",
  "social influencer": "social_media",
  "community manager": "social_media",
  community: "social_media",
  "redes sociales": "social_media",
  redes: "social_media",
  rrss: "social_media",
  pr: "pr",
  "public relations": "pr",
  press: "pr",
  "media relations": "pr",
  prensa: "pr",
  "relaciones publicas": "pr",
  rrpp: "pr",
  "pr communications": "pr",
  "pr y comunicaciones": "pr",
  "pr and communications": "pr",
  communications: "communications",
  communication: "communications",
  comms: "communications",
  comunicacion: "communications",
  comunicaciones: "communications",
  "marketing communications": "communications",
  "marketing y comunicacion": "communications",
  "marketing and communications": "communications",
  partnerships: "partnerships",
  partnership: "partnerships",
  alianzas: "partnerships",
  alianza: "partnerships",
  collaborations: "partnerships",
  collaboration: "partnerships",
  colaboraciones: "partnerships",
  colaboracion: "partnerships",
  sales: "sales",
  ventas: "sales",
  venta: "sales",
  comercial: "sales",
  commercial: "sales",
  "sales marketing": "sales",
  "sales and marketing": "sales",
  "sales y marketing": "sales",
  "ventas y marketing": "sales",
  events: "events",
  event: "events",
  eventos: "events",
  evento: "events",
  banqueting: "events",
  banquetes: "events",
  "events banqueting": "events",
  "events and banqueting": "events",
  mice: "events",
  reservations: "reservations",
  reservation: "reservations",
  reservas: "reservations",
  reserva: "reservations",
  reservaciones: "reservations",
  reservacion: "reservations",
  bookings: "reservations",
  booking: "reservations",
  general: "general",
  "general enquiries": "general",
  "general inquiries": "general",
  "general enquiry": "general",
  enquiries: "general",
  inquiries: "general",
  reception: "general",
  recepcion: "general",
  "front desk": "general",
  "consultas generales": "general",
  "informacion general": "general",
};

export const SCOPE_ALIASES: Record<string, ContactScope> = {
  property: "property",
  hotel: "property",
  propiedad: "property",
  "hotel property": "property",
  brand: "brand",
  marca: "brand",
  group: "group",
  grupo: "group",
  corporate: "group",
  corp: "group",
  corporativo: "group",
  cluster: "group",
  chain: "group",
  cadena: "group",
  "hotel group": "group",
  operator: "operator",
  operador: "operator",
  operadora: "operator",
  management: "operator",
  "management company": "operator",
  gestora: "operator",
  gestion: "operator",
  agency: "agency",
  agencia: "agency",
  representation: "agency",
  representacion: "agency",
  representative: "agency",
  representante: "agency",
  "pr agency": "agency",
  "agencia de pr": "agency",
  unknown: "unknown",
  desconocido: "unknown",
};

export const CLAIM_ALIASES: Record<string, ClaimType> = {
  "property exists": "property_exists",
  "propiedad existente": "property_exists",
  "contact confirmation": "contact_confirmation",
  "contact email found": "contact_confirmation",
  "pr contact identified": "contact_confirmation",
  "contact identified": "contact_confirmation",
  "email found": "contact_confirmation",
  "contacto confirmado": "contact_confirmation",
  "confirmacion de contacto": "contact_confirmation",
  "brand relationship": "brand_relationship",
  "relacion de marca": "brand_relationship",
  "relacion con la marca": "brand_relationship",
  "operator relationship": "operator_relationship",
  "relacion con el operador": "operator_relationship",
  "management relationship": "operator_relationship",
  "agency representation": "agency_representation",
  "pr agency of record": "agency_representation",
  "agency of record": "agency_representation",
  "agencia de representacion": "agency_representation",
  "representacion de agencia": "agency_representation",
  "creator collaboration evidence": "creator_collaboration_evidence",
  "creator collaboration": "creator_collaboration_evidence",
  "ugc influencer history": "creator_collaboration_evidence",
  "influencer history": "creator_collaboration_evidence",
  "colaboracion con creadores": "creator_collaboration_evidence",
  "historial de influencers": "creator_collaboration_evidence",
  other: "other",
};

export interface AliasResolution<T extends string> {
  /** Canonical value, or null when the cell was empty or unmapped. */
  value: T | null;
  /** True when a non-empty token did not resolve to one canonical value. */
  unmapped: boolean;
}

/**
 * Map free text onto a closed taxonomy.
 * `canonical` values use underscores (`social_media`); alias keys use the
 * folded spaced form (`social media`, `pr communications`).
 */
export function resolveAlias<T extends string>(
  input: unknown,
  canonical: readonly T[],
  aliases: Readonly<Record<string, T>>,
): AliasResolution<T> {
  const s = normalizeString(input);
  if (!s) return { value: null, unmapped: false };
  const folded = foldForMatch(s);
  const underscored = folded.replace(/ /g, "_");
  if ((canonical as readonly string[]).includes(underscored)) {
    return { value: underscored as T, unmapped: false };
  }
  const exact = aliases[folded];
  if (exact) return { value: exact, unmapped: false };

  const hay = ` ${folded} `;
  let bestLen = 0;
  let best: T | null = null;
  let conflict = false;
  for (const [alias, target] of Object.entries(aliases)) {
    if (!hay.includes(` ${alias} `)) continue;
    const len = alias.split(" ").length;
    if (len > bestLen) {
      bestLen = len;
      best = target;
      conflict = false;
    } else if (len === bestLen && target !== best) {
      conflict = true;
    }
  }
  if (conflict || best === null) return { value: null, unmapped: true };
  return { value: best, unmapped: false };
}

export function normalizeDepartment(input: unknown): {
  value: Department | null;
  unmapped: boolean;
} {
  const resolved = resolveAlias(input, DEPARTMENTS, DEPARTMENT_ALIASES);
  if (resolved.unmapped) return { value: "other", unmapped: true };
  return { value: resolved.value, unmapped: false };
}

export function normalizeContactScope(input: unknown): {
  value: ContactScope | null;
  unmapped: boolean;
} {
  const resolved = resolveAlias(input, CONTACT_SCOPES, SCOPE_ALIASES);
  if (resolved.unmapped) return { value: "unknown", unmapped: true };
  return { value: resolved.value, unmapped: false };
}

export function normalizeClaimType(input: unknown): { value: ClaimType; unmapped: boolean } {
  const raw = normalizeString(input);
  const resolved = resolveAlias(input, CLAIM_TYPES, CLAIM_ALIASES);
  if (!raw || resolved.unmapped || resolved.value === null) {
    return { value: "other", unmapped: true };
  }
  return { value: resolved.value, unmapped: false };
}

const ORG_TYPE_SET = new Set<string>(ORG_TYPES);

export function isOrgType(value: string | null | undefined): value is OrgType {
  return value != null && ORG_TYPE_SET.has(value);
}

/**
 * Organization type for an explicit organization name. The staged
 * `organizationType` wins (it came from a typed column such as
 * `management_company`). Otherwise the contact scope is the only signal.
 * A property-scoped name with no typed column stays untyped: the string is
 * kept on the contact and no organization row is invented.
 */
export function organizationTypeForContact(contact: ContactRecord): OrgType | null {
  if (isOrgType(contact.organizationType)) return contact.organizationType;
  switch (contact.contactScope) {
    case "group":
    case "brand":
      return "hotel_group";
    case "operator":
      return "operator";
    case "agency":
      return "pr_agency";
    default:
      return null;
  }
}

/** hotel_organizations.relationship for an explicit organization type. */
export function organizationRelationship(orgType: OrgType): string {
  switch (orgType) {
    case "hotel_group":
      return "corporate_group";
    case "operator":
      return "operated_by";
    case "management_company":
      return "managed_by";
    case "pr_agency":
      return "represented_by";
    case "sales_rep":
      return "other";
    default:
      return "other";
  }
}
