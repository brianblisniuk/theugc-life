/**
 * Wording shared by the contract draft screen and the export.
 * The same sentence is required in every stored template and draft (D114).
 */
export const NOT_LEGAL_ADVICE =
  "This template is not legal advice and it is not a signed contract.";

export const TO_BE_FILLED_IN = "[to be filled in]";

export const CONTRACT_KINDS = ["hotel_stay_barter", "paid", "usage_rights"] as const;

export type ContractKind = (typeof CONTRACT_KINDS)[number];

export interface ContractDraft {
  id: string;
  kind: ContractKind;
  title: string;
  body: string;
  updatedAt: string;
}

const KIND_LABEL: Record<ContractKind, string> = {
  hotel_stay_barter: "Hotel stay / barter",
  paid: "Paid collaboration",
  usage_rights: "Usage rights",
};

export function isContractKind(value: string): value is ContractKind {
  return (CONTRACT_KINDS as readonly string[]).includes(value);
}

export function contractKindLabel(kind: ContractKind): string {
  return KIND_LABEL[kind];
}

/**
 * Text for copy and print. The not-legal-advice sentence stays in the export
 * even when an edited body dropped it. The database still refuses to save a
 * body that dropped it.
 */
export function agreementExportText(title: string, body: string): string {
  const safeTitle = title.trim();
  const withNotice = body.includes(NOT_LEGAL_ADVICE) ? body : `${NOT_LEGAL_ADVICE}\n\n${body}`;
  return safeTitle ? `${safeTitle}\n\n${withNotice}` : withNotice;
}
