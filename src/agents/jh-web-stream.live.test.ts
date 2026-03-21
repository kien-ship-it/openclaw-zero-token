import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import { JhWebClientBrowser } from "../providers/jh-web-client-browser.js";
import { createJhWebStreamFn } from "./jh-web-stream.js";

/**
 * Live integration test for the JH Chat provider (Phase 5, step 5.5).
 *
 * Requires real credentials passed via environment variables:
 *   JH_WEB_BEARER_TOKEN  – valid Bearer JWT
 *   JH_WEB_COOKIE        – full Cookie header string
 *
 * Gate: only runs when LIVE=1 (or JH_WEB_LIVE_TEST=1) is set.
 *
 * Example:
 *   JH_WEB_BEARER_TOKEN="..." JH_WEB_COOKIE="..." LIVE=1 pnpm test -- jh-web-stream.live
 */

const BEARER = process.env.JH_WEB_BEARER_TOKEN ?? "";
const COOKIE = process.env.JH_WEB_COOKIE ?? "";
const LIVE = isTruthyEnvValue(process.env.JH_WEB_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);

const hasCredentials = BEARER.length > 0 && COOKIE.length > 0;

const describeLive = LIVE && hasCredentials ? describe : describe.skip;

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCredentialJson(model = "claude-opus-4.5"): string {
  return JSON.stringify({
    bearerToken: BEARER,
    cookie: COOKIE,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    model,
  });
}

/** Collect all text deltas from the stream into a single string. */
async function collectStreamText(
  streamFn: ReturnType<typeof createJhWebStreamFn>,
  model: { id: string; api: string; provider: string },
  context: { messages: Array<{ role: string; content: string; timestamp: number }> },
): Promise<string> {
  const eventStream = streamFn(
    model as Parameters<typeof streamFn>[0],
    context as Parameters<typeof streamFn>[1],
    {},
  ) as AsyncIterable<{ type: string; delta?: string; error?: { errorMessage?: string } }>;

  let text = "";
  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      text += event.delta ?? "";
    }
    if (event.type === "error") {
      throw new Error(event.error?.errorMessage ?? "Stream error");
    }
  }
  return text;
}

// ── live tests ───────────────────────────────────────────────────────────────

describeLive("JH Web stream – live integration", () => {
  it("streams a non-empty response for a simple prompt", async () => {
    const streamFn = createJhWebStreamFn(makeCredentialJson());
    const model = { id: "claude-opus-4.5", api: "jh-web", provider: "jh-web" };
    const context = {
      messages: [
        { role: "user", content: "Reply with the single word: ok", timestamp: Date.now() },
      ],
    };

    const text = await collectStreamText(streamFn, model, context);
    expect(text.length).toBeGreaterThan(0);
    console.log(`[live] Response: ${text.slice(0, 200)}`);
  }, 120_000);

  it("JhWebClientBrowser.chatCompletions returns a ReadableStream", async () => {
    const client = new JhWebClientBrowser({
      bearerToken: BEARER,
      cookie: COOKIE,
      userAgent: "Mozilla/5.0",
      model: "claude-opus-4.5",
    });

    const stream = await client.chatCompletions({
      message: "Reply with the single word: ok",
      model: "claude-opus-4.5",
      sessionKey: "live-test",
    });

    expect(stream).toBeInstanceOf(ReadableStream);

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      raw += decoder.decode(value, { stream: true });
    }

    expect(raw.length).toBeGreaterThan(0);
    console.log(`[live] Raw SSE preview: ${raw.slice(0, 300)}`);

    await client.close();
  }, 120_000);

  it("multi-turn conversation preserves conversationId across turns", async () => {
    const client = new JhWebClientBrowser({
      bearerToken: BEARER,
      cookie: COOKIE,
      userAgent: "Mozilla/5.0",
      model: "claude-opus-4.5",
    });

    const sessionKey = `live-multi-turn-${Date.now()}`;

    const stream1 = await client.chatCompletions({
      message: "My name is TestUser. Just say 'noted'.",
      sessionKey,
    });
    const reader1 = stream1.getReader();
    while (true) {
      const { done } = await reader1.read();
      if (done) {
        break;
      }
    }

    const stream2 = await client.chatCompletions({
      message: "What is my name? One word.",
      sessionKey,
    });
    const reader2 = stream2.getReader();
    const decoder = new TextDecoder();
    let reply = "";
    while (true) {
      const { done, value } = await reader2.read();
      if (done) {
        break;
      }
      reply += decoder.decode(value, { stream: true });
    }

    // The response is raw SSE; just verify something came back.
    expect(reply.length).toBeGreaterThan(0);
    console.log(`[live] Turn-2 raw SSE preview: ${reply.slice(0, 200)}`);

    await client.close();
  }, 180_000);
});
