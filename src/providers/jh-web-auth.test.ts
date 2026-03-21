import { describe, expect, it } from "vitest";
import { getTokenExpiresAt } from "./jh-web-auth.js";

function buildMockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = "fakesignature";
  return `${header}.${body}.${sig}`;
}

describe("getTokenExpiresAt", () => {
  it("returns the exp timestamp from a valid JWT", () => {
    const exp = 1800000000;
    const token = buildMockJwt({ sub: "user", exp });
    expect(getTokenExpiresAt(token)).toBe(exp);
  });

  it("returns 0 for a JWT missing exp", () => {
    const token = buildMockJwt({ sub: "user" });
    expect(getTokenExpiresAt(token)).toBe(0);
  });

  it("returns 0 for a malformed token (too few parts)", () => {
    expect(getTokenExpiresAt("notajwt")).toBe(0);
  });

  it("returns 0 for an empty string", () => {
    expect(getTokenExpiresAt("")).toBe(0);
  });

  it("returns 0 for invalid base64 payload", () => {
    expect(getTokenExpiresAt("header.!!!.sig")).toBe(0);
  });

  it("handles base64url encoding (- and _ characters) correctly", () => {
    // Build a payload that produces - or _ in base64url
    const exp = 9999999999;
    const token = buildMockJwt({ exp, padding: "~!@#$%^&*()" });
    expect(getTokenExpiresAt(token)).toBe(exp);
  });
});
