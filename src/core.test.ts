import { test, expect } from "bun:test";
import { norm, htmlToText, rank, verdictOf, railsFor, numbersIn, type Rail } from "./core";
const R = (type: string, q: boolean | null): Rail => ({ rail: type, type, url: "", status: 200, chars: 999, quote_found: q, detail: "" });
test("verdict needs the quote on two distinct rail TYPES", () => {
  expect(verdictOf([R("origin", true), R("archive", true)], "supports")).toBe("SUPPORTED");
  expect(verdictOf([R("origin", true), R("archive", true)], "contradicts")).toBe("CONTRADICTED");
  const meta = { ...R("arxiv-metadata", true) };
  expect(verdictOf([meta, { ...meta, rail: "abs" }, R("fulltext", false)], "supports")).toBe("UNVERIFIABLE"); // one type twice
  expect(verdictOf([R("origin", true), R("archive", false)], "supports")).toBe("UNVERIFIABLE");
  expect(verdictOf([R("origin", true), R("archive", true)], null)).toBe("UNVERIFIABLE");
  expect(verdictOf([], "supports")).toBe("UNVERIFIABLE");
});
test("quote survives normalisation; tags stripped only on bodies", () => {
  const body = norm(htmlToText("<p>error &lt;0.02), maintains &gt;90% &ldquo;x&rdquo; it&#8217;s</p>"));
  expect(body.includes(norm("error <0.02), maintains >90%"))).toBe(true);
  expect(norm("it’s — fine")).toBe("it's - fine");
  expect(norm(htmlToText("<script>var a='Bun';</script>hi"))).toBe("hi");
});
test("rank prefers the substantive sentence over a short title line", () => {
  const text = "Attention Is All You Need Title. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. The weather was nice that day in the lab.";
  expect(rank("The Transformer is based solely on attention", text)[0].sentence).toMatch(/^We propose/);
  expect(rank("", text)).toEqual([]);
});
test("sources: arxiv forms and URLs map to independent rails; private hosts refused", () => {
  for (const s of ["arxiv:1706.03762", "https://arxiv.org/abs/1706.03762v7", "https://arxiv.org/pdf/1706.03762"]) expect(new Set(railsFor(s).map(r => r.type)).size).toBe(2);
  expect(railsFor("https://example.org/a").map(r => r.type)).toEqual(["origin", "reader", "archive"]);
  expect(() => railsFor("http://localhost:8080/x")).toThrow();
  expect(() => railsFor("ftp://x")).toThrow();
});
test("numbers", () => { expect(numbersIn("cut cost 37% across 1,200 runs")).toEqual(["37%", "1,200"]); });
