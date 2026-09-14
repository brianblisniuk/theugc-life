/**
 * BENCHMARK BASELINE — NOT PRODUCTION B07 IMPLEMENTATION.
 *
 * =====================================================================
 *  This file is a deliberately simple lexical rules engine whose ONLY
 *  purpose is to give the model candidates a floor to beat. It is not a
 *  candidate for B07 production, it is not an architecture proposal, and
 *  it must not be promoted into `src/` or into the B07 implementation
 *  round. A test asserts this banner is present.
 * =====================================================================
 *
 * It is intentionally shallow: keyword and phrase matching over the current
 * authored text, with quoted history stripped. It will do reasonably on
 * straightforward cases and badly on the adversarial ones — which is exactly
 * the evidence the round needs about whether rules alone are sufficient.
 */
import type { CorpusCase, MessageCase, ThreadCase } from "../corpus/schema";
import type { MessageOutput, ThreadOutput } from "../schema";
import { canonicalizeSignals, type Signal } from "../taxonomy";

export const BASELINE_BANNER = "BENCHMARK BASELINE — NOT PRODUCTION B07 IMPLEMENTATION";
export const BASELINE_VERSION = "benchmark-lexical-rules-v1";

/**
 * Strip quoted history so the baseline classifies the CURRENT authored text.
 * Mirrors B06's quote-stripping discipline (D071 §8.2) at a much cruder level.
 */
export function stripQuotedHistory(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(">")) continue;
    if (/^on .+ wrote:$/i.test(trimmed)) break;
    if (/^el .+ escribió:$/i.test(trimmed)) break;
    if (/^em .+ escreveu:$/i.test(trimmed)) break;
    if (/^le .+ a écrit ?:$/i.test(trimmed)) break;
    if (/^-+\s*(original message|mensaje original|forwarded message)\s*-+$/i.test(trimmed)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

const LEXICON: Record<Signal, RegExp[]> = {
  interest: [
    /\b(interested|we'?d love|we would love|sounds (great|interesting)|keen to|excited)\b/i,
    /\b(nos interesa|nos encantaría|interesados|suena (genial|interesante))\b/i,
    /\b(temos interesse|adoraríamos|interessante)\b/i,
    /\b(intéress|nous serions ravis)\w*/i,
  ],
  request_information: [
    /\b(send (us|me)|share your|could you (send|provide)|media kit|press kit|statistics|analytics|portfolio|more (info|details))\b/i,
    /\b(envía|envíanos|comparte|kit de medios|estadísticas|más (información|detalles))\b/i,
    /\b(envie|compartilhe|mais (informações|detalhes))\b/i,
    /\b(envoyez|partagez|plus de (détails|informations))\b/i,
  ],
  redirect: [
    /\b(contact|speak|reach out|get in touch) (with|to) \b/i,
    /\b(our (pr|press|marketing|comms) (agency|team|department)|forwarded your|put you in touch|is the right person)\b/i,
    /\b(contact[ae]|hable con|nuestra agencia|nuestro departamento|te paso con)\b/i,
    /\b(fale com|nossa agência)\b/i,
    /\b(veuillez contacter|notre agence)\b/i,
  ],
  terms_discussion: [
    /\b(rate|rates|fee|fees|budget|compensation|pricing|deliverable|usage rights|per night|invoice|quote)\b/i,
    /\b(tarifa|tarifas|honorarios|presupuesto|compensación|precio|entregables|por noche)\b/i,
    /\b(tarifa|orçamento|cachê|entregáveis)\b/i,
    /\b(tarif|budget|honoraires|livrables)\b/i,
  ],
  offer: [
    /\b(we can (offer|host|provide)|we'?re able to offer|happy to host|complimentary|on the house|we propose|our offer)\b/i,
    /\b(podemos (ofrecer|alojar|invitar)|le(s)? ofrecemos|cortesía|nuestra propuesta)\b/i,
    /\b(podemos oferecer|nossa proposta|cortesia)\b/i,
    /\b(nous pouvons (offrir|vous accueillir)|notre proposition)\b/i,
  ],
  agreement: [
    /\b(confirmed|we confirm|it'?s a deal|we agree|agreed|booking is confirmed|see you on)\b/i,
    /\b(confirmad[oa]|confirmamos|de acuerdo|trato hecho|queda reservado)\b/i,
    /\b(confirmad[oa]|combinado|fechado)\b/i,
    /\b(confirmé|nous confirmons|c'?est d'?accord)\b/i,
  ],
  rejection: [
    /\b(unfortunately|we (are not|aren'?t|won'?t be) (accepting|able|interested)|we must decline|not a fit|no longer|we'?ll pass|we have to say no)\b/i,
    /\b(lamentablemente|no (estamos|podemos)|no aceptamos|no nos interesa|debemos declinar)\b/i,
    /\b(infelizmente|não (estamos|podemos)|não temos interesse)\b/i,
    /\b(malheureusement|nous ne (pouvons|sommes))\b/i,
  ],
  timing_constraint: [
    /\b(no availability|fully booked|high season|not until|after (january|february|march|april|may|june|july|august|september|october|november|december)|next (year|quarter|season)|currently closed|reopen)\b/i,
    /\b(sin disponibilidad|completo|temporada alta|hasta (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)|el año que viene|reabrimos)\b/i,
    /\b(sem disponibilidade|lotado|alta temporada|somente em)\b/i,
    /\b(complet|haute saison|pas avant)\b/i,
  ],
  other_commercial: [],
};

function matchedSignals(text: string): Signal[] {
  const found: Signal[] = [];
  for (const [signal, patterns] of Object.entries(LEXICON) as [Signal, RegExp[]][]) {
    if (patterns.some((p) => p.test(text))) found.push(signal);
  }
  return canonicalizeSignals(found);
}

export function baselineClassifyMessage(corpusCase: MessageCase): MessageOutput {
  const raw = corpusCase.messages[corpusCase.focus_index]?.text ?? "";
  const text = stripQuotedHistory(raw);
  const signals = matchedSignals(text);

  const hasRejection = signals.includes("rejection");
  const hasAdvancing =
    signals.includes("interest") ||
    signals.includes("offer") ||
    signals.includes("agreement") ||
    signals.includes("terms_discussion");

  let disposition: MessageOutput["disposition"];
  if (hasRejection && hasAdvancing) disposition = "mixed";
  else if (hasRejection) disposition = "negative";
  else if (hasAdvancing) disposition = "positive";
  else if (signals.length > 0) disposition = "neutral";
  else disposition = text.length < 40 ? "ambiguous" : "neutral";

  const evidence_strength: MessageOutput["evidence_strength"] =
    signals.length >= 2 ? "moderate" : signals.length === 1 ? "weak" : "insufficient_evidence";

  return { disposition, signals, evidence_strength };
}

export function baselineClassifyThread(corpusCase: ThreadCase): ThreadOutput {
  const targetTexts = corpusCase.messages
    .filter((m) => m.from === "target")
    .map((m) => stripQuotedHistory(m.text));
  const allTargetText = targetTexts.join("\n");
  const signals = matchedSignals(allTargetText);

  const lastTarget = targetTexts[targetTexts.length - 1] ?? "";
  const lastSignals = matchedSignals(lastTarget);

  let thread_state: ThreadOutput["thread_state"];
  if (lastSignals.includes("agreement")) thread_state = "agreement_observed";
  else if (lastSignals.includes("rejection")) thread_state = "declined_observed";
  else if (signals.includes("terms_discussion") || signals.includes("offer"))
    thread_state = "negotiating";
  else if (signals.includes("interest")) thread_state = "engaged";
  else if (targetTexts.length === 0) thread_state = "ambiguous";
  else thread_state = "unresolved";

  const cashLike =
    /\b(fee|rate|budget|pay|payment|usd|eur|\$|€|honorarios|tarifa|cachê|tarif)\b/i.test(
      allTargetText,
    );
  const inKindLike =
    /\b(host|hosted|complimentary|stay|nights|breakfast|on the house|alojar|estancia|noches|cortesía|hospedagem|diárias|séjour|nuitées)\b/i.test(
      allTargetText,
    );
  const explicitlyUnpaid =
    /\b(cannot offer (payment|a fee)|no (payment|fee|budget)|unpaid|without compensation|sin (pago|remuneración)|no podemos pagar|sem pagamento)\b/i.test(
      allTargetText,
    );

  let compensation_structure: ThreadOutput["compensation_structure"];
  if (explicitlyUnpaid && inKindLike) compensation_structure = "in_kind";
  else if (explicitlyUnpaid) compensation_structure = "unpaid";
  else if (cashLike && inKindLike) compensation_structure = "hybrid";
  else if (cashLike) compensation_structure = "paid";
  else if (inKindLike) compensation_structure = "in_kind";
  else compensation_structure = "unknown";

  const evidence_strength: ThreadOutput["evidence_strength"] =
    signals.length >= 3 ? "moderate" : signals.length >= 1 ? "weak" : "insufficient_evidence";

  return { thread_state, compensation_structure, evidence_strength };
}

export function baselineClassify(corpusCase: CorpusCase): MessageOutput | ThreadOutput {
  return corpusCase.task === "message"
    ? baselineClassifyMessage(corpusCase)
    : baselineClassifyThread(corpusCase);
}
