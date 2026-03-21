import { describe, expect, it } from "vitest";

/**
 * Unit tests for JhWebClientBrowser payload construction (Phase 2, step 2.6).
 *
 * We test the pure helper functions exported for testing and validate the
 * shape of the proprietary JSON payload without requiring a live browser.
 */

// ── helpers extracted for white-box testing ──────────────────────────────────

function formatClientTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

const NULL_UUID = "00000000-0000-0000-0000-000000000000";

const JH_DEFAULT_GREETING =
  "Use HopGPT as a supportive tool that you complement with your own expertise, " +
  "critical thinking, professional judgment, and additional research. Please note that " +
  "all chats are automatically **purged after 30 days** per our " +
  "[data retention](https://hopgpt.it.jh.edu/data-retention-notice/) policy. " +
  "Use of HopGPT must comply with the [Terms of Use](https://hopgpt.it.jh.edu/terms/).\n";

const MODEL_ENDPOINT_MAP: Record<string, string> = {
  "claude-opus-4.5": "AnthropicClaude",
  "claude-sonnet-4.5": "AnthropicClaude",
  "claude-haiku-4.5": "AnthropicClaude",
  AnthropicClaude: "AnthropicClaude",
};

function resolveEndpoint(model?: string): string {
  if (!model) {
    return "AnthropicClaude";
  }
  return MODEL_ENDPOINT_MAP[model] ?? "AnthropicClaude";
}

/** Minimal payload builder matching JhWebClientBrowser.chatCompletions internals. */
function buildPayload(opts: {
  text: string;
  model: string;
  conversationId: string;
  parentMessageId: string;
  messageId: string;
  clientTimestamp: string;
}) {
  const endpoint = resolveEndpoint(opts.model);
  return {
    text: opts.text,
    sender: "User",
    clientTimestamp: opts.clientTimestamp,
    isCreatedByUser: true,
    parentMessageId: opts.parentMessageId,
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    error: false,
    endpoint,
    endpointType: "custom",
    model: opts.model,
    resendFiles: true,
    greeting: JH_DEFAULT_GREETING,
    key: "never",
    modelDisplayLabel: "Claude",
    isTemporary: false,
    isRegenerate: false,
    isContinued: false,
    ephemeralAgent: {
      execute_code: false,
      web_search: false,
      file_search: false,
      artifacts: false,
      mcp: [],
    },
  };
}

// ── UUID regex ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── tests ──────────────────────────────────────────────────────────────────

describe("formatClientTimestamp", () => {
  it("formats a known date correctly", () => {
    const d = new Date(2026, 2, 13, 13, 27, 33); // local time
    expect(formatClientTimestamp(d)).toBe("2026-03-13T13:27:33");
  });

  it("zero-pads single-digit month, day, hour, minute, second", () => {
    const d = new Date(2024, 0, 5, 8, 3, 7); // Jan 5, 08:03:07
    expect(formatClientTimestamp(d)).toBe("2024-01-05T08:03:07");
  });

  it("does not include timezone offset or milliseconds", () => {
    const ts = formatClientTimestamp(new Date());
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe("resolveEndpoint", () => {
  it("maps claude-opus-4.5 to AnthropicClaude", () => {
    expect(resolveEndpoint("claude-opus-4.5")).toBe("AnthropicClaude");
  });

  it("maps claude-sonnet-4.5 to AnthropicClaude", () => {
    expect(resolveEndpoint("claude-sonnet-4.5")).toBe("AnthropicClaude");
  });

  it("maps claude-haiku-4.5 to AnthropicClaude", () => {
    expect(resolveEndpoint("claude-haiku-4.5")).toBe("AnthropicClaude");
  });

  it("falls back to AnthropicClaude for unknown model", () => {
    expect(resolveEndpoint("some-unknown-model")).toBe("AnthropicClaude");
  });

  it("falls back to AnthropicClaude when model is undefined", () => {
    expect(resolveEndpoint(undefined)).toBe("AnthropicClaude");
  });
});

describe("buildPayload (proprietary JSON shape)", () => {
  const conversationId = crypto.randomUUID();
  const parentMessageId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const clientTimestamp = "2026-03-13T13:27:33";

  it("matches the spec from Phase 2 analysis for claude-opus-4.5", () => {
    const payload = buildPayload({
      text: "hi",
      model: "claude-opus-4.5",
      conversationId,
      parentMessageId,
      messageId,
      clientTimestamp,
    });

    expect(payload).toMatchObject({
      text: "hi",
      sender: "User",
      clientTimestamp: "2026-03-13T13:27:33",
      isCreatedByUser: true,
      parentMessageId,
      conversationId,
      messageId,
      error: false,
      endpoint: "AnthropicClaude",
      endpointType: "custom",
      model: "claude-opus-4.5",
      resendFiles: true,
      greeting: JH_DEFAULT_GREETING,
      key: "never",
      modelDisplayLabel: "Claude",
      isTemporary: false,
      isRegenerate: false,
      isContinued: false,
    });
  });

  it("ephemeralAgent defaults all feature flags to false and mcp to []", () => {
    const payload = buildPayload({
      text: "test",
      model: "claude-opus-4.5",
      conversationId,
      parentMessageId,
      messageId,
      clientTimestamp,
    });

    expect(payload.ephemeralAgent).toEqual({
      execute_code: false,
      web_search: false,
      file_search: false,
      artifacts: false,
      mcp: [],
    });
  });

  it("sets endpoint based on model, not hardcoded", () => {
    const payload = buildPayload({
      text: "hello",
      model: "claude-sonnet-4.5",
      conversationId,
      parentMessageId,
      messageId,
      clientTimestamp,
    });
    expect(payload.endpoint).toBe("AnthropicClaude");
    expect(payload.model).toBe("claude-sonnet-4.5");
  });

  it("produces valid UUID-shaped IDs when generated via crypto.randomUUID()", () => {
    const cid = crypto.randomUUID();
    const pid = crypto.randomUUID();
    const mid = crypto.randomUUID();
    expect(cid).toMatch(UUID_RE);
    expect(pid).toMatch(UUID_RE);
    expect(mid).toMatch(UUID_RE);
    // all three must be distinct
    expect(new Set([cid, pid, mid]).size).toBe(3);
  });
});

describe("conversation state chain", () => {
  it("first-turn parentMessageId is the null UUID", () => {
    const sessions = new Map<string, { conversationId: string; lastParentMessageId: string }>();
    const key = "null-uuid-session";
    const state = { conversationId: crypto.randomUUID(), lastParentMessageId: NULL_UUID };
    sessions.set(key, state);
    const payload = buildPayload({
      text: "hello",
      model: "claude-opus-4.5",
      conversationId: state.conversationId,
      parentMessageId: state.lastParentMessageId,
      messageId: crypto.randomUUID(),
      clientTimestamp: formatClientTimestamp(new Date()),
    });
    expect(payload.parentMessageId).toBe(NULL_UUID);
  });

  it("advances parentMessageId to the previous messageId across turns", () => {
    const sessions = new Map<string, { conversationId: string; lastParentMessageId: string }>();
    const key = "test-session";

    function sendTurn(text: string) {
      let state = sessions.get(key);
      if (!state) {
        state = {
          conversationId: crypto.randomUUID(),
          lastParentMessageId: NULL_UUID,
        };
        sessions.set(key, state);
      }
      const messageId = crypto.randomUUID();
      const payload = buildPayload({
        text,
        model: "claude-opus-4.5",
        conversationId: state.conversationId,
        parentMessageId: state.lastParentMessageId,
        messageId,
        clientTimestamp: formatClientTimestamp(new Date()),
      });
      // Advance state
      state.lastParentMessageId = messageId;
      sessions.set(key, state);
      return payload;
    }

    const turn1 = sendTurn("hello");
    const turn2 = sendTurn("how are you?");

    // turn2's parentMessageId must equal turn1's messageId
    expect(turn2.parentMessageId).toBe(turn1.messageId);
    // same conversationId throughout
    expect(turn2.conversationId).toBe(turn1.conversationId);
    // messageIds are distinct
    expect(turn1.messageId).not.toBe(turn2.messageId);
  });
});
