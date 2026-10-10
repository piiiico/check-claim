#!/usr/bin/env node

// src/core.ts
var UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
var TOOL = "check-claim 0.1.0 (built by Pico, an AI agent run by Hakon Amdal; github.com/piiiico/check-claim)";
function norm(t) {
  return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—]/g, "-").replace(/\u00ad/g, "").replace(/\s+/g, " ").trim();
}
function htmlToText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\((?:https?:|\/)[^)]*\)/g, "$1");
}
async function get(url, ua = UA, ms = 15000) {
  const r = await get1(url, ua, ms);
  if (r.status !== 429 && r.status !== 503)
    return r;
  await new Promise((res) => setTimeout(res, 2500));
  return get1(url, ua, ms);
}
async function get1(url, ua, ms) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,text/plain,*/*" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, body: String(e?.message ?? e) };
  }
}
function railsFor(source) {
  const ax = source.match(/^(?:arxiv:|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/)(\d{4}\.\d{4,5})(v\d+)?/i);
  if (ax) {
    const id = ax[1] + (ax[2] ?? "");
    return [
      { rail: "arxiv-export-api", type: "arxiv-metadata", url: `https://export.arxiv.org/api/query?id_list=${id}` },
      { rail: "arxiv-abs-page", type: "arxiv-metadata", url: `https://arxiv.org/abs/${id}` },
      { rail: "arxiv-fulltext-html", type: "fulltext", url: `https://arxiv.org/html/${id}` }
    ];
  }
  if (!/^https?:\/\//i.test(source))
    throw new Error("source must be an http(s) URL or arxiv:<id>");
  const u = new URL(source);
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || u.hostname.endsWith(".internal"))
    throw new Error("private hosts are not fetched");
  return [
    { rail: "origin", type: "origin", url: source },
    { rail: "jina-reader", type: "reader", url: `https://r.jina.ai/${source}`, ua: "check-claim/0.1 (+https://github.com/piiiico/check-claim)" },
    { rail: "wayback-latest", type: "archive", url: `https://web.archive.org/web/2id_/${source}` }
  ];
}
var STOP = new Set("a an the of to in on for and or is are was were be been by with as at from that this it its into than then not no but if so do does did has have had can could will would may might should about over under per via".split(" "));
var words = (t) => (t.toLowerCase().match(/[a-z0-9][a-z0-9.%-]*/g) ?? []).map((w) => w.replace(/[.]+$/, "")).filter((w) => w.length > 1 && !STOP.has(w));
var numbersIn = (t) => [...new Set((t.match(/\d+(?:[.,]\d+)*%?/g) ?? []).filter((n) => n.replace(/\D/g, "").length > 0))];
function sentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])|\n{2,}/).map((s) => s.trim()).filter((s) => s.length >= 30 && s.length <= 600);
}
function rank(claim, text, k = 3) {
  const cw = new Set(words(claim));
  const cn = new Set(numbersIn(claim));
  if (!cw.size)
    return [];
  return sentences(text).map((s) => {
    const sw = new Set(words(s));
    let hit = 0;
    for (const w of cw)
      if (sw.has(w))
        hit += cn.has(w) ? 2 : 1;
    return { sentence: s, score: +(hit / (cw.size + cn.size) * Math.min(1, sw.size / 12)).toFixed(3) };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}
function verdictOf(rails, stance) {
  const types = new Set(rails.filter((r) => r.quote_found).map((r) => r.type));
  if (!stance || types.size < 2)
    return "UNVERIFIABLE";
  return stance === "supports" ? "SUPPORTED" : "CONTRADICTED";
}
async function checkClaim(input) {
  const claim = String(input.claim ?? "").trim(), source = String(input.source ?? "").trim();
  const quote = input.quote ? String(input.quote).trim() : null;
  const stance = quote ? input.stance ?? "supports" : null;
  if (claim.length < 5)
    throw new Error("claim is required (the sentence you want to check)");
  if (stance && stance !== "supports" && stance !== "contradicts")
    throw new Error("stance must be supports or contradicts");
  if (quote && quote.length < 20)
    throw new Error("quote must be the verbatim source sentence, at least 20 characters");
  const plan = railsFor(source);
  const fetched = await Promise.all(plan.map((p) => get(p.url, p.ua)));
  const nq = quote ? norm(quote).toLowerCase() : null;
  const rails = [];
  let bestText = "";
  plan.forEach((p, i) => {
    const f = fetched[i];
    const text = norm(htmlToText(f.body));
    const ok = f.status >= 200 && f.status < 300 && text.length > 200;
    if (ok && text.length > bestText.length && p.type !== "arxiv-metadata")
      bestText = text;
    if (ok && !bestText)
      bestText = text;
    const found = nq ? ok ? text.toLowerCase().includes(nq) : null : null;
    rails.push({
      rail: p.rail,
      type: p.type,
      url: p.url,
      status: f.status,
      chars: text.length,
      quote_found: found,
      detail: !ok ? `not readable (HTTP ${f.status}, ${text.length} chars)` : nq ? found ? "quote found verbatim" : "quote NOT found verbatim" : "fetched"
    });
  });
  const readable = rails.filter((r) => r.quote_found !== null || r.detail === "fetched");
  const verdict = verdictOf(rails, stance);
  const absentNums = bestText ? numbersIn(claim).filter((n) => !bestText.includes(n)) : [];
  const candidates = bestText ? rank(quote && !rails.some((r) => r.quote_found) ? quote : claim, bestText) : [];
  const foundTypes = new Set(rails.filter((r) => r.quote_found).map((r) => r.type));
  let finding, next = null;
  if (!readable.length && !rails.some((r) => r.quote_found === false))
    finding = "source could not be read on any rail";
  else if (!quote) {
    finding = `no quote given: ${candidates.length} candidate source sentence(s) returned`;
    next = "pick the sentence that bears on the claim and call again with quote=<that sentence verbatim> and stance=supports|contradicts";
  } else if (foundTypes.size >= 2)
    finding = `quote found verbatim on ${foundTypes.size} independent rail types; stance '${stance}' is the caller's judgment`;
  else if (foundTypes.size === 1)
    finding = "quote found on only one rail type: provenance not independently confirmed";
  else if (rails.some((r) => r.quote_found === false)) {
    finding = "QUOTE NOT IN SOURCE: the quoted sentence was not found verbatim on any readable rail";
    next = "the nearest real sentences are in candidates; quote one of them or drop the claim";
  } else
    finding = "source could not be read on any rail";
  return { verdict, claim, source, quote, stance, verbatim_source_sentence: verdict !== "UNVERIFIABLE" ? quote : null, rails, candidates, claim_numbers_absent_from_source: absentNums, finding, next, fetched_at: new Date().toISOString(), tool: TOOL };
}

// src/cli.ts
var HOSTED = "https://check-claim.amdal-dev.workers.dev/check";
var a = process.argv.slice(2);
var flag = (n) => {
  const i = a.indexOf(n);
  if (i < 0)
    return null;
  const v = a[i + 1];
  a.splice(i, 2);
  return v ?? null;
};
var local = a.includes("--local");
if (local)
  a.splice(a.indexOf("--local"), 1);
var json = a.includes("--json");
if (json)
  a.splice(a.indexOf("--json"), 1);
var quote = flag("--quote");
var stance = flag("--stance");
var [claim, source] = a;
if (!claim || !source) {
  console.error(`usage: check-claim "<claim>" <url | arxiv:id> [--quote "<sentence copied verbatim from the source>"] [--stance supports|contradicts] [--local] [--json]`);
  process.exit(2);
}
var args = { claim, source, quote, stance };
var r;
if (local)
  r = await checkClaim(args);
else {
  const res = await fetch(HOSTED, { method: "POST", headers: { "content-type": "application/json", "user-agent": "check-claim-cli/0.1", ...process.env.CHECK_CLAIM_OWN ? { "x-own-call": process.env.CHECK_CLAIM_OWN } : {} }, body: JSON.stringify(args) });
  r = await res.json();
  if (!res.ok) {
    console.error(r.error ?? res.status);
    process.exit(2);
  }
}
if (json) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}
console.log(`${r.verdict} · ${r.finding}`);
for (const x of r.rails)
  console.log(`  ${x.rail.padEnd(20)} HTTP ${String(x.status).padEnd(4)} ${x.detail}`);
if (r.claim_numbers_absent_from_source.length)
  console.log(`  numbers in the claim not found in the source: ${r.claim_numbers_absent_from_source.join(", ")}`);
if (r.candidates.length) {
  console.log("closest source sentences:");
  for (const c of r.candidates)
    console.log(`  [${c.score}] ${c.sentence.slice(0, 300)}`);
}
if (r.next)
  console.log(`next: ${r.next}`);
process.exit(r.verdict === "UNVERIFIABLE" ? 1 : 0);
