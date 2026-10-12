/**
 * ISO 4217 alphabetic codes accepted for collaboration compensation (D078).
 *
 * The list is fixed in source so a Node `Intl` difference cannot change what
 * the database and the form agree to store. Exponents are the ISO minor-unit
 * digits used only to convert a creator-entered major amount into integer
 * minor units. They are not a price list.
 */
export const ISO_CURRENCIES = [
  "AED",
  "AFN",
  "ALL",
  "AMD",
  "ANG",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BGN",
  "BHD",
  "BIF",
  "BMD",
  "BND",
  "BOB",
  "BRL",
  "BSD",
  "BTN",
  "BWP",
  "BYN",
  "BZD",
  "CAD",
  "CDF",
  "CHF",
  "CLP",
  "CNY",
  "COP",
  "CRC",
  "CUC",
  "CUP",
  "CVE",
  "CZK",
  "DJF",
  "DKK",
  "DOP",
  "DZD",
  "EGP",
  "ERN",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GHS",
  "GIP",
  "GMD",
  "GNF",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HRK",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "IQD",
  "IRR",
  "ISK",
  "JMD",
  "JOD",
  "JPY",
  "KES",
  "KGS",
  "KHR",
  "KMF",
  "KPW",
  "KRW",
  "KWD",
  "KYD",
  "KZT",
  "LAK",
  "LBP",
  "LKR",
  "LRD",
  "LSL",
  "LYD",
  "MAD",
  "MDL",
  "MGA",
  "MKD",
  "MMK",
  "MNT",
  "MOP",
  "MRU",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "OMR",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "PYG",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "RWF",
  "SAR",
  "SBD",
  "SCR",
  "SDG",
  "SEK",
  "SGD",
  "SHP",
  "SLE",
  "SLL",
  "SOS",
  "SRD",
  "SSP",
  "STN",
  "SVC",
  "SYP",
  "SZL",
  "THB",
  "TJS",
  "TMT",
  "TND",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "UGX",
  "USD",
  "UYU",
  "UZS",
  "VES",
  "VND",
  "VUV",
  "WST",
  "XAF",
  "XCD",
  "XCG",
  "XDR",
  "XOF",
  "XPF",
  "XSU",
  "YER",
  "ZAR",
  "ZMW",
  "ZWG",
  "ZWL",
] as const;

export type IsoCurrency = (typeof ISO_CURRENCIES)[number];

const ISO_SET = new Set<string>(ISO_CURRENCIES);

/** Largest integer minor amount that survives a JavaScript number unchanged. */
export const MAX_MINOR_AMOUNT = 9_007_199_254_740_991;

const ZERO_EXPONENT = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_EXPONENT = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function isIsoCurrency(value: string): value is IsoCurrency {
  return ISO_SET.has(value);
}

/** Minor-unit digits. Currencies not in the zero or three sets use two. */
export function currencyExponent(code: string): number {
  if (ZERO_EXPONENT.has(code)) return 0;
  if (THREE_EXPONENT.has(code)) return 3;
  return 2;
}

/**
 * Convert a creator-typed major amount into integer minor units.
 * Extra fractional digits are rejected. They are not rounded.
 */
export function majorToMinor(
  raw: string,
  currency: string,
): { ok: true; minor: number } | { ok: false } {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { ok: false };
  if (!isIsoCurrency(currency)) return { ok: false };
  const exponent = currencyExponent(currency);
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > exponent) return { ok: false };
  const digits = exponent === 0 ? whole! : `${whole}${fraction.padEnd(exponent, "0")}`;
  if (digits.length > 16) return { ok: false };
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor) || minor < 0 || minor > MAX_MINOR_AMOUNT) return { ok: false };
  return { ok: true, minor };
}
