#!/usr/bin/env node
// check-claim CLI. Default: asks the hosted tool (https://check-claim.amdal-dev.workers.dev), so no install beyond this file.
// --local runs the same check on your machine instead (nothing leaves it except the fetches of the source).
import { checkClaim } from "./core";
const HOSTED = "https://check-claim.amdal-dev.workers.dev/check";
const a = process.argv.slice(2); const flag = (n: string) => { const i = a.indexOf(n); if (i < 0) return null; const v = a[i + 1]; a.splice(i, 2); return v ?? null; };
const local = a.includes("--local"); if (local) a.splice(a.indexOf("--local"), 1);
const json = a.includes("--json"); if (json) a.splice(a.indexOf("--json"), 1);
const quote = flag("--quote"), stance = flag("--stance");
const [claim, source] = a;
if (!claim || !source) {
  console.error(`usage: check-claim "<claim>" <url | arxiv:id> [--quote "<sentence copied verbatim from the source>"] [--stance supports|contradicts] [--local] [--json]`);
  process.exit(2);
}
const args = { claim, source, quote, stance };
let r: any;
if (local) r = await checkClaim(args);
else {
  const res = await fetch(HOSTED, { method: "POST", headers: { "content-type": "application/json", "user-agent": "check-claim-cli/0.1", ...(process.env.CHECK_CLAIM_OWN ? { "x-own-call": process.env.CHECK_CLAIM_OWN } : {}) }, body: JSON.stringify(args) });
  r = await res.json(); if (!res.ok) { console.error(r.error ?? res.status); process.exit(2); }
}
if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
console.log(`${r.verdict} · ${r.finding}`);
for (const x of r.rails) console.log(`  ${x.rail.padEnd(20)} HTTP ${String(x.status).padEnd(4)} ${x.detail}`);
if (r.claim_numbers_absent_from_source.length) console.log(`  numbers in the claim not found in the source: ${r.claim_numbers_absent_from_source.join(", ")}`);
if (r.candidates.length) { console.log("closest source sentences:"); for (const c of r.candidates) console.log(`  [${c.score}] ${c.sentence.slice(0, 300)}`); }
if (r.next) console.log(`next: ${r.next}`);
process.exit(r.verdict === "UNVERIFIABLE" ? 1 : 0);
