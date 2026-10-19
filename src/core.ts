// check_claim: does the source say what the claim says it says?
// Code checks PROVENANCE: is the quoted sentence really in the source, on more than one independent fetch path.
// The STANCE (does that sentence support or contradict the claim) is the caller's judgment, recorded as such.
// Without a quote, the tool returns the source sentences that best match the claim, so the caller can pick one.
// Runs unchanged in Bun, Node 18+ and Cloudflare Workers (fetch only).

export type Verdict = "SUPPORTED" | "CONTRADICTED" | "UNVERIFIABLE";
export type Rail = { rail: string; type: string; url: string; status: number; chars: number; quote_found: boolean | null; detail: string };
export type Result = {
  verdict: Verdict;
  claim: string;
  source: string;
  quote: string | null;
  stance: "supports" | "contradicts" | null;
  verbatim_source_sentence: string | null;
  rails: Rail[];
  candidates: { sentence: string; score: number }[];
  claim_numbers_absent_from_source: string[];
  finding: string;
  next: string | null;
  fetched_at: string;
  tool: string;
};

// Say what we are. Paired on 536 hosts (2026-10-19): this UA read 327, a Chrome costume 325; Anubis sites challenge the costume.
const UA = "check-claim/0.1 (AI agent; +https://github.com/piiiico/check-claim)";
const TOOL = "check-claim 0.1.0 (built by Pico, an AI agent run by Hakon Amdal; github.com/piiiico/check-claim)";

export function norm(t: string): string {
  return t
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—]/g, "-").replace(/\u00ad/g, "")
    .replace(/\s+/g, " ").trim();
}
// Tags are stripped on fetched BODIES only, never on the quote: "<0.02" in a quote must survive.
export function htmlToText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\((?:https?:|\/)[^)]*\)/g, "$1"); // reader-markdown links -> text
}

// One retry on 429/503: the reader and archive paths rate-limit shared egress (Cloudflare Workers) in bursts.
async function get(url: string, ua = UA, ms = 15000): Promise<{ status: number; body: string }> {
  const r = await get1(url, ua, ms);
  if (r.status !== 429 && r.status !== 503) return r;
  await new Promise(res => setTimeout(res, 2500));
  return get1(url, ua, ms);
}
async function get1(url: string, ua: string, ms: number): Promise<{ status: number; body: string }> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,text/plain,*/*" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  } catch (e: any) { return { status: 0, body: String(e?.message ?? e) }; }
}

// Fetch paths. Each TYPE is an independent route to the source's text; two rails of one type count once.
export function railsFor(source: string): { rail: string; type: string; url: string; ua?: string }[] {
  const ax = source.match(/^(?:arxiv:|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/)(\d{4}\.\d{4,5})(v\d+)?/i);
  if (ax) {
    const id = ax[1] + (ax[2] ?? "");
    return [
      { rail: "arxiv-export-api", type: "arxiv-metadata", url: `https://export.arxiv.org/api/query?id_list=${id}` },
      { rail: "arxiv-abs-page", type: "arxiv-metadata", url: `https://arxiv.org/abs/${id}` },
      { rail: "arxiv-fulltext-html", type: "fulltext", url: `https://arxiv.org/html/${id}` },
    ];
  }
  if (!/^https?:\/\//i.test(source)) throw new Error("source must be an http(s) URL or arxiv:<id>");
  const u = new URL(source);
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || u.hostname.endsWith(".internal")) throw new Error("private hosts are not fetched");
  return [
    { rail: "origin", type: "origin", url: source },
    { rail: "jina-reader", type: "reader", url: `https://r.jina.ai/${source}` },
    { rail: "wayback-latest", type: "archive", url: `https://web.archive.org/web/2id_/${source}` },
  ];
}

const STOP = new Set("a an the of to in on for and or is are was were be been by with as at from that this it its into than then not no but if so do does did has have had can could will would may might should about over under per via".split(" "));
const words = (t: string) => (t.toLowerCase().match(/[a-z0-9][a-z0-9.%-]*/g) ?? []).map(w => w.replace(/[.]+$/, "")).filter(w => w.length > 1 && !STOP.has(w));
export const numbersIn = (t: string) => [...new Set((t.match(/\d+(?:[.,]\d+)*%?/g) ?? []).filter(n => n.replace(/\D/g, "").length > 0))];

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])|\n{2,}/).map(s => s.trim()).filter(s => s.length >= 30 && s.length <= 600);
}
export function rank(claim: string, text: string, k = 3): { sentence: string; score: number }[] {
  const cw = new Set(words(claim)); const cn = new Set(numbersIn(claim));
  if (!cw.size) return [];
  return sentences(text).map(s => {
    const sw = new Set(words(s));
    let hit = 0; for (const w of cw) if (sw.has(w)) hit += cn.has(w) ? 2 : 1;
    // short boilerplate lines (titles, nav) match many claim words by accident: damp anything under 12 content words
    return { sentence: s, score: +((hit / (cw.size + cn.size)) * Math.min(1, sw.size / 12)).toFixed(3) };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

export function verdictOf(rails: Rail[], stance: Result["stance"]): Verdict {
  const types = new Set(rails.filter(r => r.quote_found).map(r => r.type));
  if (!stance || types.size < 2) return "UNVERIFIABLE";
  return stance === "supports" ? "SUPPORTED" : "CONTRADICTED";
}

export async function checkClaim(input: { claim: string; source: string; quote?: string | null; stance?: string | null }): Promise<Result> {
  const claim = String(input.claim ?? "").trim(), source = String(input.source ?? "").trim();
  const quote = input.quote ? String(input.quote).trim() : null;
  const stance = quote ? ((input.stance ?? "supports") as Result["stance"]) : null;
  if (claim.length < 5) throw new Error("claim is required (the sentence you want to check)");
  if (stance && stance !== "supports" && stance !== "contradicts") throw new Error("stance must be supports or contradicts");
  if (quote && quote.length < 20) throw new Error("quote must be the verbatim source sentence, at least 20 characters");
  const plan = railsFor(source);
  const fetched = await Promise.all(plan.map(p => get(p.url, p.ua)));
  const nq = quote ? norm(quote).toLowerCase() : null;
  const rails: Rail[] = []; let bestText = "";
  plan.forEach((p, i) => {
    const f = fetched[i]; const text = norm(htmlToText(f.body));
    const ok = f.status >= 200 && f.status < 300 && text.length > 200;
    if (ok && text.length > bestText.length && p.type !== "arxiv-metadata") bestText = text;
    if (ok && !bestText) bestText = text;
    const found = nq ? (ok ? text.toLowerCase().includes(nq) : null) : null;
    rails.push({ rail: p.rail, type: p.type, url: p.url, status: f.status, chars: text.length, quote_found: found,
      detail: !ok ? `not readable (HTTP ${f.status}, ${text.length} chars)` : nq ? (found ? "quote found verbatim" : "quote NOT found verbatim") : "fetched" });
  });
  const readable = rails.filter(r => r.quote_found !== null || r.detail === "fetched");
  const verdict = verdictOf(rails, stance);
  const absentNums = bestText ? numbersIn(claim).filter(n => !bestText.includes(n)) : [];
  const candidates = bestText ? rank(quote && !rails.some(r => r.quote_found) ? quote : claim, bestText) : [];
  const foundTypes = new Set(rails.filter(r => r.quote_found).map(r => r.type));
  let finding: string, next: string | null = null;
  if (!readable.length && !rails.some(r => r.quote_found === false)) finding = "source could not be read on any rail";
  else if (!quote) { finding = `no quote given: ${candidates.length} candidate source sentence(s) returned`; next = "pick the sentence that bears on the claim and call again with quote=<that sentence verbatim> and stance=supports|contradicts"; }
  else if (foundTypes.size >= 2) finding = `quote found verbatim on ${foundTypes.size} independent rail types; stance '${stance}' is the caller's judgment`;
  else if (foundTypes.size === 1) finding = "quote found on only one rail type: provenance not independently confirmed";
  else if (rails.some(r => r.quote_found === false)) { finding = "QUOTE NOT IN SOURCE: the quoted sentence was not found verbatim on any readable rail"; next = "the nearest real sentences are in candidates; quote one of them or drop the claim"; }
  else finding = "source could not be read on any rail";
  return { verdict, claim, source, quote, stance, verbatim_source_sentence: verdict !== "UNVERIFIABLE" ? quote : null, rails, candidates, claim_numbers_absent_from_source: absentNums, finding, next, fetched_at: new Date().toISOString(), tool: TOOL };
}
