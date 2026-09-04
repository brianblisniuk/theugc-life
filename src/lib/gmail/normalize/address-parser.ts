import addressparser from "addressparser";

import type { AddressHeaderName, NormalizedParticipantInput } from "@/lib/gmail/normalize/contract";

/**
 * SYNTACTIC ADDRESS-LIST PARSING, AND NOTHING MORE.
 *
 * `addressparser` (the library nodemailer itself uses) is a real RFC
 * 5322-aware tokenizer: it respects quoted strings, so a display name
 * containing a comma does not split into two addresses, and it understands
 * RFC 2822 group syntax (`Undisclosed-recipients:;`). It never throws — a
 * header that cannot be resolved into a clean address still produces a token
 * carrying whatever text was recovered, which is exactly the shape B04 needs:
 * malformed evidence is a ROW, never an absence.
 *
 * What this module refuses to do, deliberately:
 *
 *   - strip `+tag` addressing;
 *   - collapse Gmail's dot-insensitive local part;
 *   - lowercase or otherwise rewrite the local part as identity truth;
 *   - merge two address entries into "the same person";
 *   - decode RFC 2047 encoded-words (`=?UTF-8?B?...?=`) in a display name —
 *     that is a MIME text-decoding step, not address-list parsing, and is out
 *     of scope for V1: the raw header value remains available verbatim via
 *     the linked header row for a later block that wants it.
 */

function splitAddrSpec(address: string): { localPart: string; domain: string } | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { localPart: address.slice(0, at), domain: address.slice(at + 1) };
}

interface FlatEntry {
  name: string;
  address: string;
  /**
   * True ONLY for a real RFC 2822 group construct naming zero addresses
   * (`Undisclosed-recipients:;`). This has to be tracked explicitly rather
   * than inferred from an empty `address`+`name` shape below: `addressparser`
   * represents BOTH a genuine empty group AND ordinary unparseable garbage
   * text as `{name: "<text>", address: ""}` — flattening away the group
   * marker made the two indistinguishable, which misclassified a legitimate
   * empty-group construct as `malformed`.
   */
  isEmptyGroup: boolean;
}

/** Flatten `addressparser`'s group syntax into a linear list, in order. */
function flatten(entries: addressparser.EmailAddress[]): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const entry of entries) {
    if (Array.isArray(entry.group)) {
      if (entry.group.length === 0) {
        // `Undisclosed-recipients:;` — a real RFC 2822 construct that names
        // zero addresses. This is not a malformed header; it is a header that
        // legitimately carries none. Represented distinctly below.
        out.push({ name: entry.name ?? "", address: "", isEmptyGroup: true });
      } else {
        out.push(...flatten(entry.group));
      }
    } else {
      out.push({ name: entry.name ?? "", address: entry.address ?? "", isEmptyGroup: false });
    }
  }
  return out;
}

/**
 * Parse ONE header occurrence's value into ordered participant rows.
 *
 * A header value that tokenizes to literally nothing (empty, whitespace-only,
 * unparseable garbage) still yields exactly ONE row, `malformed`, carrying the
 * raw value — a malformed header must remain participant evidence, not
 * silently produce zero rows.
 */
export function parseParticipants(
  headerName: AddressHeaderName,
  occurrenceIndex: number,
  rawValue: string,
): NormalizedParticipantInput[] {
  const trimmed = rawValue.trim();
  const flat = trimmed.length > 0 ? flatten(addressparser(rawValue)) : [];

  if (flat.length === 0) {
    return [
      {
        source_header_name: headerName,
        source_header_occurrence_index: occurrenceIndex,
        participant_order: 0,
        display_name: null,
        addr_spec: null,
        local_part: null,
        domain: null,
        domain_lower: null,
        raw_fragment: trimmed.length > 0 ? rawValue : null,
        parse_status: "malformed",
      },
    ];
  }

  return flat.map((entry, participantOrder) => {
    const name = entry.name.trim();
    const address = entry.address.trim();

    if (entry.isEmptyGroup) {
      // A genuine RFC 2822 group naming zero addresses. Distinct from
      // `malformed`: nothing was there to fail parsing, as opposed to
      // something unparseable being present. The group's own name (if any)
      // is kept as display evidence, not as a parse failure fragment.
      return {
        source_header_name: headerName,
        source_header_occurrence_index: occurrenceIndex,
        participant_order: participantOrder,
        display_name: name.length > 0 ? name : null,
        addr_spec: null,
        local_part: null,
        domain: null,
        domain_lower: null,
        raw_fragment: null,
        parse_status: "empty_group",
      };
    }

    if (address.length === 0) {
      return {
        source_header_name: headerName,
        source_header_occurrence_index: occurrenceIndex,
        participant_order: participantOrder,
        display_name: null,
        addr_spec: null,
        local_part: null,
        domain: null,
        domain_lower: null,
        raw_fragment: name,
        parse_status: "malformed",
      };
    }

    const split = splitAddrSpec(address);
    if (!split) {
      return {
        source_header_name: headerName,
        source_header_occurrence_index: occurrenceIndex,
        participant_order: participantOrder,
        display_name: name.length > 0 ? name : null,
        addr_spec: null,
        local_part: null,
        domain: null,
        domain_lower: null,
        raw_fragment: address,
        parse_status: "malformed",
      };
    }

    return {
      source_header_name: headerName,
      source_header_occurrence_index: occurrenceIndex,
      participant_order: participantOrder,
      display_name: name.length > 0 ? name : null,
      addr_spec: address,
      local_part: split.localPart,
      domain: split.domain,
      domain_lower: split.domain.toLowerCase(),
      raw_fragment: null,
      parse_status: "parsed",
    };
  });
}
