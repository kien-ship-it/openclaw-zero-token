import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { JhWebClientBrowser, type JhWebClientOptions } from "../providers/jh-web-client-browser.js";

export function createJhWebStreamFn(credentialJson: string): StreamFn {
  let options: JhWebClientOptions;
  try {
    options = JSON.parse(credentialJson) as JhWebClientOptions;
  } catch {
    throw new Error("[JH Web] Invalid credential JSON passed to createJhWebStreamFn");
  }
  const client = new JhWebClientBrowser(options);

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        const sessionKey = (context as unknown as { sessionId?: string }).sessionId || "default";
        const messages = context.messages || [];
        const systemPrompt = (context as unknown as { systemPrompt?: string }).systemPrompt || "";

        // Build tool prompt if tools are available
        const tools = context.tools || [];
        let toolPrompt = "";

        if (tools.length > 0) {
          toolPrompt = "\n## Tool Use Instructions\n";
          toolPrompt +=
            "You are equipped with specialized tools to perform actions or retrieve information. " +
            'To use a tool, output a specific XML tag: <tool_call id="unique_id" name="tool_name">{"arg": "value"}</tool_call>. ' +
            "Rules for tool use:\n" +
            "1. ALWAYS think before calling a tool. Explain your reasoning inside <think> tags.\n" +
            "2. The 'id' attribute should be a unique 8-character string for each call.\n" +
            "3. Wait for the tool result before proceeding with further analysis.\n\n" +
            "### Special Instructions for Browser Tool\n" +
            "- **Profile 'openclaw' (Independent/Recommended)**: Opens a SEPARATE independent browser window. Use this for consistent, isolated sessions. Highly recommended for complex automation.\n" +
            "- Profile 'chrome' (Shared): Uses your existing Chrome tabs (requires extension). Use this if you need to access personal logins or already open tabs.\n" +
            "- **CONSISTENCY RULE**: Once you have started using a profile (or if you are switched to 'openclaw' due to connection errors), STAY with that profile for the remainder of the session. Do NOT switch back and forth as it will open redundant browser instances.\n\n" +
            "### Automation Policy\n" +
            "- DO NOT use the 'exec' tool to install secondary automation libraries like Playwright, Selenium, or Puppeteer if the 'browser' tool fails.\n" +
            "- Instead, inform the user about the connection issue or try the alternative browser profile ('openclaw').\n" +
            "- Installing automation tools via 'exec' is slow and redundant; the 'browser' tool is the primary way to interact with web content.\n\n" +
            "### Available Tools\n";

          for (const tool of tools) {
            toolPrompt += `#### ${tool.name}\n${tool.description}\n`;
            toolPrompt += `Parameters: ${JSON.stringify(tool.parameters)}\n\n`;
          }
        }

        // Build prompt based on conversation state
        let prompt = "";

        const historyParts: string[] = [];
        let systemPromptContent = systemPrompt;

        if (toolPrompt) {
          systemPromptContent += toolPrompt;
        }

        if (systemPromptContent) {
          historyParts.push(`System: ${systemPromptContent}`);
        }

        for (const m of messages) {
          const role = m.role === "user" || m.role === "toolResult" ? "User" : "Assistant";
          let content = "";

          if (m.role === "toolResult") {
            const tr = m as unknown as ToolResultMessage;
            let resultText = "";
            if (Array.isArray(tr.content)) {
              for (const part of tr.content) {
                if (part.type === "text") {
                  resultText += part.text;
                }
              }
            }
            content = `\n<tool_response id="${tr.toolCallId}" name="${tr.toolName}">\n${resultText}\n</tool_response>\n`;
          } else if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part.type === "text") {
                content += part.text;
              } else if (part.type === "thinking") {
                content += `<think>\n${part.thinking}\n</think>\n`;
              } else if (part.type === "toolCall") {
                const tc = part;
                content += `<tool_call id="${tc.id}" name="${tc.name}">${JSON.stringify(tc.arguments)}</tool_call>`;
              }
            }
          } else {
            content = String(m.content);
          }
          historyParts.push(`${role}: ${content}`);
        }
        prompt = historyParts.join("\n\n");

        // Add tool reminder for continuing conversations with tools
        if (toolPrompt) {
          prompt +=
            '\n\n[SYSTEM HINT]: Keep in mind your available tools. To use a tool, you MUST output the EXACT XML format: <tool_call id="unique_id" name="tool_name">{"arg": "value"}</tool_call>. Using plain text to describe your action will FAIL to execute the tool.';
        }

        if (!prompt.trim()) {
          throw new Error("[JH Web] No message found to send to JH Chat API");
        }

        console.log(
          `[JhWebStream] Starting run – session: ${sessionKey}, prompt length: ${prompt.length}`,
        );
        console.log(`[JhWebStream] Tools available: ${tools.length}`);

        const responseStream = await client.chatCompletions({
          message: prompt,
          model: model.id,
          sessionKey,
          signal: streamOptions?.signal,
        });

        if (!responseStream) {
          throw new Error("[JH Web] API returned empty response body");
        }

        const reader = responseStream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Content accumulator and event-stream helpers
        const indexMap = new Map<string, number>();
        let nextIndex = 0;
        const contentParts: (TextContent | ThinkingContent | ToolCall)[] = [];
        const accumulatedToolCalls: {
          id: string;
          name: string;
          arguments: string;
          index: number;
        }[] = [];

        const createPartial = (): AssistantMessage => {
          const msg: AssistantMessage = {
            role: "assistant",
            content: [...contentParts],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
            timestamp: Date.now(),
          };
          (msg as AssistantMessage & { thinking_enabled?: boolean }).thinking_enabled =
            contentParts.some((p) => p.type === "thinking");
          return msg;
        };

        let currentMode: "text" | "thinking" | "tool_call" = "text";
        let currentToolName = "";
        let currentToolIndex = 0;
        let tagBuffer = "";

        const emitDelta = (
          type: "text" | "thinking" | "toolcall",
          delta: string,
          forceId?: string,
        ) => {
          if (delta === "" && type !== "toolcall") {
            return;
          }
          const key = type === "toolcall" ? `tool_${currentToolIndex}` : type;

          if (!indexMap.has(key)) {
            const index = nextIndex++;
            indexMap.set(key, index);
            if (type === "text") {
              contentParts[index] = { type: "text", text: "" };
              stream.push({ type: "text_start", contentIndex: index, partial: createPartial() });
            } else if (type === "thinking") {
              contentParts[index] = { type: "thinking", thinking: "" };
              stream.push({
                type: "thinking_start",
                contentIndex: index,
                partial: createPartial(),
              });
            } else if (type === "toolcall") {
              const toolId = forceId || `call_${Date.now()}_${index}`;
              contentParts[index] = {
                type: "toolCall",
                id: toolId,
                name: currentToolName,
                arguments: {},
              };
              accumulatedToolCalls[currentToolIndex] = {
                id: toolId,
                name: currentToolName,
                arguments: "",
                index: currentToolIndex,
              };
              stream.push({
                type: "toolcall_start",
                contentIndex: index,
                partial: createPartial(),
              });
            }
          }

          const index = indexMap.get(key)!;
          if (type === "text") {
            (contentParts[index] as TextContent).text += delta;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "thinking") {
            (contentParts[index] as ThinkingContent).thinking += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "toolcall") {
            accumulatedToolCalls[currentToolIndex].arguments += delta;
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          }
        };

        const pushDelta = (delta: string) => {
          if (!delta) {
            return;
          }
          tagBuffer += delta;

          const checkTags = () => {
            const thinkStart = tagBuffer.match(/<think\b[^<>]*>/i);
            const thinkEnd = tagBuffer.match(/<\/think\b[^<>]*>/i);
            const toolCallStart = tagBuffer.match(
              /<tool_call\s*(?:id=['"]?([^'"]+)['"]?\s*)?name=['"]?([^'"]+)['"]?\s*>/i,
            );
            const toolCallEnd = tagBuffer.match(/<\/tool_call\s*>/i);

            const indices = [
              {
                type: "think_start",
                idx: thinkStart?.index ?? -1,
                len: thinkStart?.[0].length ?? 0,
              },
              { type: "think_end", idx: thinkEnd?.index ?? -1, len: thinkEnd?.[0].length ?? 0 },
              {
                type: "tool_start",
                idx: toolCallStart?.index ?? -1,
                len: toolCallStart?.[0].length ?? 0,
                id: toolCallStart?.[1],
                name: toolCallStart?.[2],
              },
              {
                type: "tool_end",
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
                if (currentMode === "thinking") {
                  emitDelta("thinking", before);
                } else if (currentMode === "tool_call") {
                  emitDelta("toolcall", before);
                } else {
                  emitDelta("text", before);
                }
              }

              if (first.type === "think_start") {
                currentMode = "thinking";
              } else if (first.type === "think_end") {
                currentMode = "text";
              } else if (first.type === "tool_start") {
                currentMode = "tool_call";
                currentToolName = first.name!;
                emitDelta("toolcall", "", first.id);
              } else if (first.type === "tool_end") {
                const index = indexMap.get(`tool_${currentToolIndex}`);
                if (index !== undefined) {
                  const part = contentParts[index] as ToolCall;
                  const argStr = accumulatedToolCalls[currentToolIndex].arguments || "{}";

                  let cleanedArg = argStr.trim();
                  if (cleanedArg.startsWith("```json")) {
                    cleanedArg = cleanedArg.substring(7);
                  } else if (cleanedArg.startsWith("```")) {
                    cleanedArg = cleanedArg.substring(3);
                  }
                  if (cleanedArg.endsWith("```")) {
                    cleanedArg = cleanedArg.substring(0, cleanedArg.length - 3);
                  }
                  cleanedArg = cleanedArg.trim();

                  try {
                    part.arguments = JSON.parse(cleanedArg);
                  } catch (e) {
                    part.arguments = { raw: argStr };
                    console.error(
                      `[JhWebStream] Failed to parse JSON for tool call ${currentToolName}:`,
                      argStr,
                      "\nError:",
                      e,
                    );
                  }
                  stream.push({
                    type: "toolcall_end",
                    contentIndex: index,
                    toolCall: part,
                    partial: createPartial(),
                  });
                }
                currentMode = "text";
                currentToolIndex++;
              }
              tagBuffer = tagBuffer.slice(first.idx + first.len);
              checkTags();
            } else {
              const lastAngle = tagBuffer.lastIndexOf("<");
              if (lastAngle === -1) {
                const mode =
                  currentMode === "thinking"
                    ? "thinking"
                    : currentMode === "tool_call"
                      ? "toolcall"
                      : "text";
                emitDelta(mode, tagBuffer);
                tagBuffer = "";
              } else if (lastAngle > 0) {
                const safe = tagBuffer.slice(0, lastAngle);
                const mode =
                  currentMode === "thinking"
                    ? "thinking"
                    : currentMode === "tool_call"
                      ? "toolcall"
                      : "text";
                emitDelta(mode, safe);
                tagBuffer = tagBuffer.slice(lastAngle);
              }
            }
          };
          checkTags();
        };

        // JH Web SSE format – the server sends two flavours depending on
        // version / agent type:
        //
        // (A) LibreChat-style (observed live):
        //   event: message
        //   data: {"message":{"messageId":"...","text":"accumulated text so far",...}}
        //
        // (B) Anthropic-agent-style (documented in analysis):
        //   event: on_message_delta
        //   data: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"Hello"}]}}}
        //
        // We support both.  For (A) the `text` field contains the *full*
        // accumulated response so far, so we diff against the previous value
        // to extract the delta.
        let currentEventName = "";
        let prevMessageText = "";
        let debugLoggedFirstEvent = false;

        const processLine = (line: string) => {
          if (line.startsWith("event:")) {
            currentEventName = line.slice(6).trim();
            return;
          }

          if (line.startsWith("data:")) {
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") {
              return;
            }

            try {
              const parsed = JSON.parse(dataStr) as Record<string, unknown>;

              if (!debugLoggedFirstEvent) {
                debugLoggedFirstEvent = true;
                const jsonEventField = typeof parsed.event === "string" ? parsed.event : undefined;
                console.log(
                  `[JhWebStream] First SSE event=${currentEventName} jsonEvent=${jsonEventField ?? "none"} keys=${Object.keys(parsed).join(",")}`,
                );
              }

              // The SSE `event:` line is always "message" for JH Web.
              // The REAL event type lives in the JSON payload's `event` field.
              const jsonEvent = typeof parsed.event === "string" ? parsed.event : undefined;

              // ── on_message_delta: the actual AI response text deltas ──
              if (jsonEvent === "on_message_delta") {
                const dataObj = parsed.data as
                  | {
                      delta?: { content?: Array<{ type: string; text?: string }> };
                    }
                  | undefined;
                const contentArr = dataObj?.delta?.content;
                if (Array.isArray(contentArr)) {
                  for (const block of contentArr) {
                    if (block.type === "text" && typeof block.text === "string") {
                      pushDelta(block.text);
                    }
                  }
                }
                return;
              }

              // ── User echo + final summary (has `message` key) ─────
              if (parsed.message) {
                const msg = parsed.message as {
                  text?: string;
                  sender?: string;
                  isCreatedByUser?: boolean;
                };

                // Skip the user's own message echoed back
                if (msg.isCreatedByUser === true || msg.sender === "User") {
                  return;
                }

                // Final summary event may carry accumulated text
                if (typeof msg.text === "string" && msg.text) {
                  const delta = msg.text.slice(prevMessageText.length);
                  prevMessageText = msg.text;
                  if (delta) {
                    pushDelta(delta);
                  }
                }
              }
            } catch {
              // Malformed JSON – skip silently
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush any remaining buffered line
            if (buffer.trim()) {
              processLine(buffer.trim());
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const combined = buffer + chunk;
          const lines = combined.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            processLine(line.trimEnd());
          }
        }

        // Flush remaining tag buffer
        if (tagBuffer) {
          const mode =
            (currentMode as string) === "thinking"
              ? "thinking"
              : (currentMode as string) === "tool_call"
                ? "toolcall"
                : "text";
          emitDelta(mode, tagBuffer);
        }

        console.log(
          `[JhWebStream] Stream complete. Parts: ${contentParts.length}, Tools: ${accumulatedToolCalls.length}`,
        );

        stream.push({
          type: "done",
          reason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
          message: createPartial(),
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[JhWebStream] Error: ${errorMessage}`);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        } as AssistantMessageEvent);
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
