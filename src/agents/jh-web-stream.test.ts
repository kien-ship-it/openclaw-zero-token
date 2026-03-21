import { describe, expect, it } from "vitest";

/**
 * Unit tests for the JH Chat SSE stream parser (Phase 3, step 3.6).
 *
 * The parser logic is extracted here as pure functions so we can test it
 * without instantiating JhWebClientBrowser or hitting any network.
 *
 * SSE format produced by chat.ai.jh.edu:
 *   event: on_message_delta
 *   data: {"event":"on_message_delta","data":{"id":"step_xxx","delta":{"content":[{"type":"text","text":"Hello"}]}}}
 */

// ── Inline parser extracted from jh-web-stream.ts for white-box testing ──────

interface ParsedDelta {
  type: "text_start" | "text_delta" | "done" | "skip";
  delta?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface SseChunkPayload {
  event?: string;
  data?: {
    id?: string;
    delta?: {
      content?: ContentBlock[];
    };
  };
}

function parseJhSseLines(rawLines: string[]): ParsedDelta[] {
  const results: ParsedDelta[] = [];
  let currentEventName = "";
  let textStarted = false;

  const processLine = (line: string) => {
    if (line.startsWith("event:")) {
      currentEventName = line.slice(6).trim();
      return;
    }

    if (line.startsWith("data:")) {
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") {
        results.push({ type: "done" });
        return;
      }

      if (currentEventName !== "on_message_delta") {
        results.push({ type: "skip" });
        return;
      }

      let parsed: SseChunkPayload;
      try {
        parsed = JSON.parse(dataStr) as SseChunkPayload;
      } catch {
        results.push({ type: "skip" });
        return;
      }

      const eventField = parsed.event ?? currentEventName;
      if (eventField !== "on_message_delta") {
        results.push({ type: "skip" });
        return;
      }

      const contentArr = parsed.data?.delta?.content;
      if (!Array.isArray(contentArr)) {
        results.push({ type: "skip" });
        return;
      }

      for (const block of contentArr) {
        if (block.type === "text" && typeof block.text === "string") {
          if (!textStarted) {
            textStarted = true;
            results.push({ type: "text_start" });
          }
          results.push({ type: "text_delta", delta: block.text });
        }
      }
    }
  };

  for (const line of rawLines) {
    processLine(line.trimEnd());
  }

  return results;
}

/** Build a well-formed on_message_delta SSE event string (two lines). */
function makeSseDelta(text: string, stepId = "step_abc"): string[] {
  return [
    "event: on_message_delta",
    `data: ${JSON.stringify({
      event: "on_message_delta",
      data: {
        id: stepId,
        delta: { content: [{ type: "text", text }] },
      },
    })}`,
  ];
}

/** Collect only text_delta values from parser output. */
function collectDeltas(results: ParsedDelta[]): string[] {
  return results.filter((r) => r.type === "text_delta").map((r) => r.delta ?? "");
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("JH SSE parser – single delta", () => {
  it("emits text_start then text_delta for a single on_message_delta event", () => {
    const lines = makeSseDelta("Hello");
    const results = parseJhSseLines(lines);

    expect(results.some((r) => r.type === "text_start")).toBe(true);
    expect(collectDeltas(results)).toEqual(["Hello"]);
  });

  it("extracts the correct text string", () => {
    const lines = makeSseDelta("World");
    expect(collectDeltas(parseJhSseLines(lines))).toEqual(["World"]);
  });

  it("only emits one text_start even for a single delta", () => {
    const lines = makeSseDelta("Hi");
    const starts = parseJhSseLines(lines).filter((r) => r.type === "text_start");
    expect(starts).toHaveLength(1);
  });
});

describe("JH SSE parser – multi-chunk stream", () => {
  it("concatenates deltas from multiple on_message_delta events in order", () => {
    const lines = [
      ...makeSseDelta("Hello", "step_1"),
      "",
      ...makeSseDelta(", ", "step_2"),
      "",
      ...makeSseDelta("world!", "step_3"),
    ];

    const deltas = collectDeltas(parseJhSseLines(lines));
    expect(deltas).toEqual(["Hello", ", ", "world!"]);
    expect(deltas.join("")).toBe("Hello, world!");
  });

  it("emits text_start only once across multiple deltas", () => {
    const lines = [...makeSseDelta("a"), "", ...makeSseDelta("b"), "", ...makeSseDelta("c")];
    const starts = parseJhSseLines(lines).filter((r) => r.type === "text_start");
    expect(starts).toHaveLength(1);
  });

  it("handles content blocks with multiple text items in one delta", () => {
    const lines = [
      "event: on_message_delta",
      `data: ${JSON.stringify({
        event: "on_message_delta",
        data: {
          id: "step_multi",
          delta: {
            content: [
              { type: "text", text: "foo" },
              { type: "text", text: "bar" },
            ],
          },
        },
      })}`,
    ];
    expect(collectDeltas(parseJhSseLines(lines))).toEqual(["foo", "bar"]);
  });

  it("skips non-text content blocks (e.g. type=image)", () => {
    const lines = [
      "event: on_message_delta",
      `data: ${JSON.stringify({
        event: "on_message_delta",
        data: {
          id: "step_mixed",
          delta: {
            content: [
              { type: "image", url: "https://example.com/img.png" },
              { type: "text", text: "caption" },
            ],
          },
        },
      })}`,
    ];
    expect(collectDeltas(parseJhSseLines(lines))).toEqual(["caption"]);
  });
});

describe("JH SSE parser – malformed JSON", () => {
  it("skips a data line that is not valid JSON without throwing", () => {
    const lines = ["event: on_message_delta", "data: {this is not json}"];
    expect(() => parseJhSseLines(lines)).not.toThrow();
    expect(collectDeltas(parseJhSseLines(lines))).toEqual([]);
  });

  it("skips truncated JSON gracefully", () => {
    const lines = [
      "event: on_message_delta",
      'data: {"event":"on_message_delta","data":{"delta":{"content":',
    ];
    expect(() => parseJhSseLines(lines)).not.toThrow();
    expect(collectDeltas(parseJhSseLines(lines))).toEqual([]);
  });

  it("recovers and parses a valid line after a malformed one", () => {
    const lines = ["event: on_message_delta", "data: GARBAGE", "", ...makeSseDelta("recovery")];
    expect(collectDeltas(parseJhSseLines(lines))).toEqual(["recovery"]);
  });
});

describe("JH SSE parser – empty stream", () => {
  it("returns no events for an empty line array", () => {
    expect(parseJhSseLines([])).toEqual([]);
  });

  it("returns no text deltas for a stream with only blank lines", () => {
    expect(collectDeltas(parseJhSseLines(["", "", ""]))).toEqual([]);
  });

  it("returns done marker for [DONE] sentinel", () => {
    const lines = ["event: on_message_delta", "data: [DONE]"];
    const results = parseJhSseLines(lines);
    expect(results.some((r) => r.type === "done")).toBe(true);
    expect(collectDeltas(results)).toEqual([]);
  });

  it("ignores events that are not on_message_delta", () => {
    const lines = [
      "event: on_chain_start",
      `data: ${JSON.stringify({ event: "on_chain_start", data: {} })}`,
      "",
      "event: on_tool_start",
      `data: ${JSON.stringify({ event: "on_tool_start", data: {} })}`,
    ];
    expect(collectDeltas(parseJhSseLines(lines))).toEqual([]);
  });

  it("ignores data lines with no preceding event: on_message_delta", () => {
    const lines = [
      // No event: line at all
      `data: ${JSON.stringify({
        event: "on_message_delta",
        data: { id: "x", delta: { content: [{ type: "text", text: "ghost" }] } },
      })}`,
    ];
    // currentEventName is "" so the guard filters it out
    expect(collectDeltas(parseJhSseLines(lines))).toEqual([]);
  });
});

describe("JH SSE parser – edge cases", () => {
  it("handles whitespace-only text blocks (emits them as-is)", () => {
    const lines = makeSseDelta("   ");
    expect(collectDeltas(parseJhSseLines(lines))).toEqual(["   "]);
  });

  it("handles unicode / emoji in text delta", () => {
    const lines = makeSseDelta("Hello 🌍");
    expect(collectDeltas(parseJhSseLines(lines))).toEqual(["Hello 🌍"]);
  });

  it("handles a delta whose content array is empty", () => {
    const lines = [
      "event: on_message_delta",
      `data: ${JSON.stringify({
        event: "on_message_delta",
        data: { id: "step_empty", delta: { content: [] } },
      })}`,
    ];
    expect(collectDeltas(parseJhSseLines(lines))).toEqual([]);
  });

  it("handles missing data.delta gracefully", () => {
    const lines = [
      "event: on_message_delta",
      `data: ${JSON.stringify({ event: "on_message_delta", data: { id: "step_nodelta" } })}`,
    ];
    expect(() => parseJhSseLines(lines)).not.toThrow();
    expect(collectDeltas(parseJhSseLines(lines))).toEqual([]);
  });
});
