// Hosted check_claim: MCP (streamable HTTP, stateless JSON responses) at /mcp and a plain JSON API at /check.
// Every tools/call and /check call is logged (time, user-agent, MCP client name, salted IP hash, source host, verdict)
// so the tool's author can count who uses it. Calls carrying the header x-own-call are the author's own tests.
import { checkClaim } from "./core";

type Env = { CALLS: KVNamespace; ADMIN: string; SALT: string };
const VERSION = "0.1.0";
const TOOL = {
  name: "check_claim",
  title: "Check a claim against its source",
  description:
    "Check whether a source really says what a claim says it says, before you publish the claim. Give the claim and the source (an http(s) URL or arxiv:<id>). " +
    "Without a quote you get back the source sentences that best match the claim. With quote (a sentence copied verbatim from the source) and stance (supports|contradicts, your judgment), " +
    "the tool fetches the source on independent paths (origin, reader, web archive; for arXiv: metadata and full text) and returns SUPPORTED or CONTRADICTED only if the quote is found verbatim on at least two of them, else UNVERIFIABLE. " +
    "A quote that is not in the source is reported as QUOTE NOT IN SOURCE, with the nearest real sentences. No key needed.",
  inputSchema: {
    type: "object",
    properties: {
      claim: { type: "string", description: "The sentence you want to check, as you would publish it." },
      source: { type: "string", description: "The source the claim rests on: an http(s) URL, or arxiv:<id>." },
      quote: { type: "string", description: "Optional. The sentence from the source, copied verbatim, that bears on the claim." },
      stance: { type: "string", enum: ["supports", "contradicts"], description: "Optional, with quote. Whether that sentence supports or contradicts the claim (default supports)." },
    },
    required: ["claim", "source"],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

async function ipHash(req: Request, salt: string) {
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ip));
  return [...new Uint8Array(d)].slice(0, 6).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function log(env: Env, req: Request, row: Record<string, unknown>) {
  const at = new Date().toISOString();
  const rec = { at, ua: req.headers.get("user-agent")?.slice(0, 200) ?? null, ip: await ipHash(req, env.SALT), country: (req as any).cf?.country ?? null,
    own: req.headers.has("x-own-call"), ...row };
  await env.CALLS.put(`call:${at}:${crypto.randomUUID().slice(0, 8)}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 400 });
}

async function run(env: Env, req: Request, args: any, via: string, client: string | null) {
  const base = { via, client, source_host: (() => { try { return new URL(String(args?.source)).hostname; } catch { return String(args?.source ?? "").slice(0, 40); } })(),
    claim: String(args?.claim ?? "").slice(0, 200), had_quote: !!args?.quote };
  try {
    const r = await checkClaim(args ?? {});
    await log(env, req, { ...base, verdict: r.verdict, finding: r.finding.slice(0, 80) });
    return { ok: true as const, r };
  } catch (e: any) {
    await log(env, req, { ...base, error: String(e?.message ?? e).slice(0, 120) });
    return { ok: false as const, error: String(e?.message ?? e) };
  }
}

const json = (b: unknown, status = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...h } });

async function mcp(env: Env, req: Request): Promise<Response> {
  let msg: any;
  try { msg = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
  if (Array.isArray(msg)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches not supported" } }, 400);
  const { id, method, params } = msg ?? {};
  const client = req.headers.get("x-mcp-client") ?? null;
  if (id === undefined || id === null) return new Response(null, { status: 202 }); // notification
  const ok = (result: unknown) => json({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      await log(env, req, { via: "mcp-initialize", client: params?.clientInfo ? `${params.clientInfo.name}/${params.clientInfo.version}` : null });
      return ok({ protocolVersion: ["2025-06-18", "2025-03-26", "2024-11-05"].includes(params?.protocolVersion) ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "check-claim", title: "check_claim", version: VERSION },
        instructions: "One tool, check_claim. Call it before you publish a claim that rests on a source." });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== "check_claim") return json({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
      const out = await run(env, req, params?.arguments, "mcp", client);
      if (!out.ok) return ok({ content: [{ type: "text", text: `error: ${out.error}` }], isError: true });
      return ok({ content: [{ type: "text", text: JSON.stringify(out.r, null, 2) }], structuredContent: out.r });
    }
    default: return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const HOME = `check_claim: does the source say what the claim says it says?

MCP (streamable HTTP): POST https://check-claim.amdal-dev.workers.dev/mcp   tool: check_claim(claim, source, quote?, stance?)
JSON:  GET https://check-claim.amdal-dev.workers.dev/check?claim=...&source=...&quote=...&stance=supports
CLI:   npx github:piiiico/check-claim "<claim>" <source> [--quote "<verbatim sentence>"] [--stance supports|contradicts]

No key. Calls are logged (time, user-agent, salted IP hash, source host, first 200 chars of the claim) so the author can count use.
Code: https://github.com/piiiico/check-claim
Built by Pico, an AI agent run by Hakon Amdal (Stavanger, Norway).
`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" } });
    if (url.pathname === "/mcp") {
      if (req.method === "POST") return mcp(env, req);
      return new Response("this endpoint speaks MCP over POST (streamable HTTP, JSON responses)", { status: 405, headers: { allow: "POST" } });
    }
    if (url.pathname === "/check") {
      const args = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
      const out = await run(env, req, args, "http", null);
      return out.ok ? json(out.r) : json({ error: out.error }, 400);
    }
    if (url.pathname === "/calls") {
      if (!env.ADMIN || url.searchParams.get("key") !== env.ADMIN) return new Response("forbidden", { status: 403 });
      const rows: unknown[] = []; let cursor: string | undefined;
      do {
        const l = await env.CALLS.list({ prefix: "call:", cursor });
        for (const k of l.keys) rows.push(JSON.parse((await env.CALLS.get(k.name)) ?? "null"));
        cursor = l.list_complete ? undefined : l.cursor;
      } while (cursor);
      return json({ n: rows.length, rows });
    }
    if (url.pathname === "/" || url.pathname === "") return new Response(HOME, { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/.well-known/mcp/server-card.json") return json({ serverInfo: { name: "check-claim", version: VERSION }, tools: [TOOL] });
    return new Response("not found", { status: 404 });
  },
};
