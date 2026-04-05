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

// ── XML tool_call / think tag parser tests ──────────────────────────────────
//
// The production jh-web-stream pushDelta logic buffers incoming text and scans
// for <tool_call ...>...</tool_call> and <think>...</think> XML tags.  We
// replicate the core parsing here to validate extraction.

interface TagParserEvent {
  type: "text" | "thinking" | "toolcall_start" | "toolcall_delta" | "toolcall_end";
  content?: string;
  toolName?: string;
  toolId?: string;
  parsedArgs?: Record<string, unknown>;
}

/**
 * Minimal standalone reimplementation of the pushDelta/checkTags logic from
 * jh-web-stream.ts for white-box testing.
 */
function parseTagsFromText(input: string): TagParserEvent[] {
  const events: TagParserEvent[] = [];
  let currentMode: "text" | "thinking" | "tool_call" = "text";
  let currentToolName = "";
  let currentToolArgs = "";
  let currentToolId = "";
  let tagBuffer = "";

  const flush = (mode: "text" | "thinking" | "tool_call", content: string) => {
    if (!content) {
      return;
    }
    if (mode === "text") {
      events.push({ type: "text", content });
    } else if (mode === "thinking") {
      events.push({ type: "thinking", content });
    } else if (mode === "tool_call") {
      currentToolArgs += content;
      events.push({ type: "toolcall_delta", content });
    }
  };

  const checkTags = () => {
    const thinkStart = tagBuffer.match(/<think\b[^<>]*>/i);
    const thinkEnd = tagBuffer.match(/<\/think\b[^<>]*>/i);
    const toolCallStart = tagBuffer.match(
      /<tool_call\s*(?:id=['"]?([^'"]+)['"]?\s*)?name=['"]?([^'"]+)['"]?\s*>/i,
    );
    const toolCallEnd = tagBuffer.match(/<\/tool_call\s*>/i);

    const indices = [
      {
        type: "think_start" as const,
        idx: thinkStart?.index ?? -1,
        len: thinkStart?.[0].length ?? 0,
      },
      { type: "think_end" as const, idx: thinkEnd?.index ?? -1, len: thinkEnd?.[0].length ?? 0 },
      {
        type: "tool_start" as const,
        idx: toolCallStart?.index ?? -1,
        len: toolCallStart?.[0].length ?? 0,
        id: toolCallStart?.[1],
        name: toolCallStart?.[2],
      },
      {
        type: "tool_end" as const,
        idx: toolCallEnd?.index ?? -1,
        len: toolCallEnd?.[0].length ?? 0,
      },
    ]
      .filter((t) => t.idx !== -1)
      .toSorted((a, b) => a.idx - b.idx);

    if (indices.length > 0) {
      const first = indices[0];
      const before = tagBuffer.slice(0, first.idx);
      if (before) {
        flush(currentMode, before);
      }

      if (first.type === "think_start") {
        currentMode = "thinking";
      } else if (first.type === "think_end") {
        currentMode = "text";
      } else if (first.type === "tool_start") {
        currentMode = "tool_call";
        currentToolName = (first as { name?: string }).name ?? "";
        currentToolId = (first as { id?: string }).id ?? `auto_${Date.now()}`;
        currentToolArgs = "";
        events.push({ type: "toolcall_start", toolName: currentToolName, toolId: currentToolId });
      } else if (first.type === "tool_end") {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(currentToolArgs.trim());
        } catch {
          parsed = { raw: currentToolArgs };
        }
        events.push({
          type: "toolcall_end",
          toolName: currentToolName,
          toolId: currentToolId,
          parsedArgs: parsed,
        });
        currentMode = "text";
        currentToolArgs = "";
      }
      tagBuffer = tagBuffer.slice(first.idx + first.len);
      checkTags();
    } else {
      const lastAngle = tagBuffer.lastIndexOf("<");
      if (lastAngle === -1) {
        flush(currentMode, tagBuffer);
        tagBuffer = "";
      } else if (lastAngle > 0) {
        flush(currentMode, tagBuffer.slice(0, lastAngle));
        tagBuffer = tagBuffer.slice(lastAngle);
      }
    }
  };

  tagBuffer = input;
  checkTags();
  // Flush remainder
  if (tagBuffer) {
    flush(currentMode, tagBuffer);
  }

  return events;
}

describe("XML tag parser – tool_call extraction", () => {
  it("extracts a single tool_call with id and name", () => {
    const input =
      'I will edit the file now.\n<tool_call id="abc12345" name="edit">{"file":"test.ts","content":"hello"}</tool_call>\nDone.';
    const events = parseTagsFromText(input);

    const starts = events.filter((e) => e.type === "toolcall_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].toolName).toBe("edit");
    expect(starts[0].toolId).toBe("abc12345");

    const ends = events.filter((e) => e.type === "toolcall_end");
    expect(ends).toHaveLength(1);
    expect(ends[0].parsedArgs).toEqual({ file: "test.ts", content: "hello" });

    // Text before and after the tag
    const texts = events.filter((e) => e.type === "text").map((e) => e.content);
    expect(texts.some((t) => t?.includes("I will edit"))).toBe(true);
    expect(texts.some((t) => t?.includes("Done."))).toBe(true);
  });

  it("extracts multiple tool_call tags in sequence", () => {
    const input =
      '<tool_call id="t1" name="read">{"path":"a.ts"}</tool_call>' +
      '<tool_call id="t2" name="write">{"path":"b.ts","data":"x"}</tool_call>';
    const events = parseTagsFromText(input);

    const starts = events.filter((e) => e.type === "toolcall_start");
    expect(starts).toHaveLength(2);
    expect(starts[0].toolName).toBe("read");
    expect(starts[1].toolName).toBe("write");

    const ends = events.filter((e) => e.type === "toolcall_end");
    expect(ends).toHaveLength(2);
    expect(ends[0].parsedArgs).toEqual({ path: "a.ts" });
    expect(ends[1].parsedArgs).toEqual({ path: "b.ts", data: "x" });
  });

  it("handles tool_call with malformed JSON arguments gracefully", () => {
    const input = '<tool_call id="bad1" name="exec">not valid json</tool_call>';
    const events = parseTagsFromText(input);

    const ends = events.filter((e) => e.type === "toolcall_end");
    expect(ends).toHaveLength(1);
    expect(ends[0].parsedArgs).toEqual({ raw: "not valid json" });
  });

  it("handles think tags around tool calls", () => {
    const input =
      "<think>Let me edit this file</think>" +
      '<tool_call id="x1" name="edit">{"file":"foo.ts"}</tool_call>';
    const events = parseTagsFromText(input);

    const thinkEvents = events.filter((e) => e.type === "thinking");
    expect(thinkEvents.length).toBeGreaterThanOrEqual(1);
    expect(thinkEvents.map((e) => e.content).join("")).toBe("Let me edit this file");

    const starts = events.filter((e) => e.type === "toolcall_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].toolName).toBe("edit");
  });

  it("returns only text events when no tags are present", () => {
    const input = "Just a plain response with no tool calls.";
    const events = parseTagsFromText(input);

    expect(events.every((e) => e.type === "text")).toBe(true);
    expect(events.map((e) => e.content).join("")).toBe(input);
  });
});
