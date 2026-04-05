# Research: Isolating JH Web as a Standalone OpenAI-Compatible Gateway

## Objective

Extract the JH web token collection and streaming from `openclaw-zero-token` into a **separate, self-contained application** that serves a local OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`). Any client that speaks the OpenAI protocol (openclaw, Continue, Cursor, aider, Open WebUI, etc.) can connect to it.

---

## Current Implementation Inventory

### Files to extract (source → purpose)

| File                                                 | Role                                                   | LOC  |
| ---------------------------------------------------- | ------------------------------------------------------ | ---- |
| `src/providers/jh-web-auth.ts`                       | Playwright CDP attach, captures Bearer token + cookies | ~227 |
| `src/providers/jh-web-client-browser.ts`             | Sends chat via in-browser fetch (Cloudflare bypass)    | ~500 |
| `src/agents/jh-web-stream.ts`                        | SSE parser + XML tool_call/think tag parser            | ~540 |
| `src/commands/auth-choice.apply.jh-web.ts`           | Onboarding CLI for auth                                | ~120 |
| `src/commands/onboard-auth.credentials.ts` (partial) | `setJhWebCredentials` / `getJhWebCredentials`          | ~45  |

### Internal openclaw dependencies these files pull in

| Import                            | Used by      | What it provides                                                      |
| --------------------------------- | ------------ | --------------------------------------------------------------------- |
| `src/browser/chrome.ts`           | auth, client | `launchOpenClawChrome`, `stopOpenClawChrome`, `getChromeWebSocketUrl` |
| `src/browser/cdp.helpers.ts`      | auth, client | `getHeadersWithAuth`                                                  |
| `src/browser/config.ts`           | auth, client | `resolveBrowserConfig`, `resolveProfile`                              |
| `src/config/io.ts`                | auth, client | `loadConfig()` → full `OpenClawConfig`                                |
| `@mariozechner/pi-agent-core`     | stream       | `StreamFn` type                                                       |
| `@mariozechner/pi-ai`             | stream       | `AssistantMessage`, `AssistantMessageEvent`, content types            |
| `src/browser/cdp-proxy-bypass.ts` | cdp.helpers  | proxy agent for CDP                                                   |
| `src/browser/cdp-timeouts.ts`     | cdp.helpers  | timeout constants                                                     |
| `src/browser/extension-relay.ts`  | cdp.helpers  | extension auth headers                                                |
| `src/infra/ports.ts`              | chrome.ts    | `ensurePortAvailable`                                                 |
| `src/logging/subsystem.ts`        | chrome.ts    | logger                                                                |

### External dependencies (keep as-is)

- `playwright-core` — CDP browser connection
- `ws` — WebSocket client (used by Chrome CDP discovery)

---

## Pathways Evaluated

### Pathway A: Full Standalone Repository

**Approach:** New repo/project. Copy and simplify the ~1300 LOC of JH-specific code. Replace all openclaw internal imports with self-contained equivalents. Add an HTTP server that speaks OpenAI protocol.

| Pros                                       | Cons                                         |
| ------------------------------------------ | -------------------------------------------- |
| Zero runtime coupling to openclaw          | Duplicates ~100 LOC of browser CDP helpers   |
| Works as a drop-in for any OpenAI client   | Must be maintained separately                |
| Minimal dependency footprint               | Initial copy + adaptation effort (~2-3 days) |
| Can be published as standalone npm package |                                              |

### Pathway B: Monorepo Workspace Package

**Approach:** New package under `packages/jh-web-gateway`. Imports shared browser infra from the main openclaw package via workspace links.

| Pros                                | Cons                                              |
| ----------------------------------- | ------------------------------------------------- |
| Shares code, stays in sync          | Still requires openclaw checkout + `pnpm install` |
| Lower initial effort                | Cannot run without the monorepo                   |
| Builds with the rest of the project | Pulls in the full openclaw dependency tree        |

### Pathway C: OpenClaw Extension/Plugin

**Approach:** New extension under `extensions/jh-web-gateway` that adds HTTP routes to the openclaw gateway.

| Pros                                       | Cons                                     |
| ------------------------------------------ | ---------------------------------------- |
| Integrates with existing gateway auth      | Must run inside openclaw gateway process |
| Minimal new code                           | Not truly standalone                     |
| Uses existing `/v1/chat/completions` infra | Users must run full openclaw to use it   |

### Pathway D: Thin Bridge (Standalone + Adapted)

**Approach:** Standalone project that adapts (not copies verbatim) the essential logic. Replaces openclaw's config/browser/stream abstractions with minimal self-contained equivalents. Same concept as A, but emphasizes clean adaptation over wholesale copy.

| Pros                                  | Cons                              |
| ------------------------------------- | --------------------------------- |
| Same benefits as A                    | Same maintenance as A             |
| Cleaner code (no legacy abstractions) | Slightly more upfront design work |
| Can be evolved independently          |                                   |

---

## Recommendation: Pathway D — Standalone Thin Bridge

This is the best fit for the stated goal ("separate application that serves a local API compliant gateway"). Pathways B and C fail the "separate application" requirement since they depend on the openclaw monorepo or gateway process.

---

## Proposed Architecture

```
jh-web-gateway/
├── src/
│   ├── cli.ts              # Entry point: `jh-gw auth` / `jh-gw serve`
│   ├── server.ts           # Hono HTTP server: /v1/chat/completions, /v1/models
│   ├── auth.ts             # Browser CDP attach → capture Bearer + cookies
│   ├── client.ts           # In-browser fetch client (Cloudflare bypass)
│   ├── stream-translator.ts # JH SSE → OpenAI SSE/JSON translation
│   ├── tool-parser.ts      # XML <tool_call>/<think> tag extraction
│   ├── chrome-cdp.ts       # Minimal CDP: discover WS URL, connect
│   ├── config.ts           # ~/.jh-gateway/config.json management
│   └── types.ts            # Shared types
├── package.json
├── tsconfig.json
└── README.md
```

### Dependencies (minimal)

```json
{
  "dependencies": {
    "playwright-core": "^1.52",
    "hono": "^4.7",
    "@hono/node-server": "^1.14",
    "ws": "^8.18"
  },
  "devDependencies": {
    "typescript": "^5.8",
    "vitest": "^3.1"
  }
}
```

No `@mariozechner/pi-*` packages. No openclaw packages.

---

## Module-by-Module Extraction Plan

### 1. `chrome-cdp.ts` — Minimal CDP Helper (~60 LOC)

**Replaces:** `src/browser/chrome.ts` (394 LOC) + `src/browser/cdp.helpers.ts` (242 LOC) + `src/browser/config.ts`

Only need two functions:

```typescript
// Fetch /json/version from Chrome's CDP HTTP endpoint
export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs?: number,
): Promise<string | null>;

// Auth headers for CDP connection (empty for local, or relay auth)
export function getHeadersWithAuth(wsUrl: string): Record<string, string>;
```

**What gets dropped:** Chrome launch/stop, profile management, executable detection, user-data-dir, port management, extension relay auth, profile decoration. The standalone gateway only supports **attach mode** (user starts Chrome with `--remote-debugging-port=9222`).

### 2. `config.ts` — Simple JSON Config (~80 LOC)

**Replaces:** `src/config/io.ts` + `OpenClawConfig` type system

```typescript
interface GatewayConfig {
  cdpUrl: string; // default: "http://127.0.0.1:9222"
  credentials: {
    bearerToken: string;
    cookie: string;
    userAgent: string;
  } | null;
  port: number; // default: 8741
  defaultModel: string; // default: "claude-opus-4.5"
  defaultEndpoint: string; // default: "AnthropicClaude"
}
```

Config stored at `~/.jh-gateway/config.json`. No auth-profiles.json, no OpenClawConfig.

### 3. `auth.ts` — Browser Credential Capture (~150 LOC)

**Adapted from:** `src/providers/jh-web-auth.ts` (227 LOC)

Simplified flow:

1. Connect to Chrome via CDP (`getChromeWebSocketUrl`)
2. Find or open `chat.ai.jh.edu` page
3. Intercept requests for `Authorization: Bearer` header
4. Poll cookies for session tokens
5. Save to `config.json`

**Dropped:** `loadConfig()`, `resolveBrowserConfig()`, `resolveProfile()`, `launchOpenClawChrome()`, `stopOpenClawChrome()`. Replaced with direct CDP URL from config.

### 4. `client.ts` — Browser-Based API Client (~300 LOC)

**Adapted from:** `src/providers/jh-web-client-browser.ts` (500 LOC)

Core preserved:

- In-browser `fetch()` via `page.evaluate()` (Cloudflare bypass)
- Model → endpoint mapping (`claude-opus-4.5` → `AnthropicClaude`, etc.)
- Conversation state management (parentMessageId chain)
- JWT expiry check
- 401 auto re-auth

**Dropped:** `loadConfig()`, `resolveBrowserConfig()`, full `ensureBrowser()` complexity. Simplified to: read CDP URL from config, connect, find/open JH page.

**Changed:** Returns raw SSE string (same as current) but the stream translator handles conversion to OpenAI format instead of pi-ai types.

### 5. `tool-parser.ts` — XML Tag Parser (~120 LOC)

**Extracted from:** `src/agents/jh-web-stream.ts` lines 251-374

The `pushDelta` / `checkTags` logic that scans for:

- `<tool_call id="..." name="...">...</tool_call>` → extracted as tool calls
- `<think>...</think>` → extracted as reasoning content

This is pure string processing with zero external dependencies. Direct extraction.

### 6. `stream-translator.ts` — JH SSE → OpenAI Format (~250 LOC)

**Adapted from:** `src/agents/jh-web-stream.ts` (540 LOC)

**Input:** Raw SSE text from `client.ts`

**Output:** OpenAI-compatible SSE chunks or JSON response

#### SSE Translation Map

| JH Event                                                | Action                   | OpenAI Output                      |
| ------------------------------------------------------- | ------------------------ | ---------------------------------- |
| `event: message` + `isCreatedByUser: true`              | Skip (user echo)         | —                                  |
| `event: on_message_delta` + `data.delta.content[].text` | Extract text delta       | `choices[0].delta.content`         |
| `event: on_run_step`                                    | Skip (metadata)          | —                                  |
| Final summary (`responseMessage`)                       | Extract accumulated text | `choices[0].delta.content` (delta) |

#### Tool Call Translation

When the XML parser detects `<tool_call>` tags in the text stream:

```
# JH response text contains:
<tool_call id="abc" name="read_file">{"path": "foo.ts"}</tool_call>

# Translated to OpenAI SSE:
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"abc","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"foo.ts\"}"}}]}}]}
```

#### Think Tag Translation

```
# JH response text contains:
<think>Let me analyze this...</think>

# Option A: Strip thinking from content (default)
# Option B: Include as a separate field (if client supports it)
```

### 7. `server.ts` — OpenAI-Compatible HTTP Server (~200 LOC)

**Inspired by:** `src/gateway/openai-http.ts` (612 LOC)

Endpoints:

#### `GET /v1/models`

```json
{
  "data": [
    { "id": "claude-opus-4.5", "object": "model", "owned_by": "jh-web" },
    { "id": "claude-sonnet-4.5", "object": "model", "owned_by": "jh-web" },
    { "id": "gpt-4o", "object": "model", "owned_by": "jh-web" },
    { "id": "gemini-2.0-flash", "object": "model", "owned_by": "jh-web" }
  ]
}
```

#### `POST /v1/chat/completions`

**Request (OpenAI format):**

```json
{
  "model": "claude-opus-4.5",
  "stream": true,
  "messages": [
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "Hello" }
  ],
  "tools": [
    { "type": "function", "function": { "name": "read_file", "parameters": {...} } }
  ]
}
```

**Processing pipeline:**

```
OpenAI messages → flatten to single prompt text
                → inject tool XML instructions (if tools present)
                → send via client.ts (browser fetch)
                → receive JH SSE response
                → parse with stream-translator.ts
                → emit OpenAI SSE chunks (or collect for non-streaming)
```

**Streaming response (OpenAI SSE format):**

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"claude-opus-4.5","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"claude-opus-4.5","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"claude-opus-4.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 8. `cli.ts` — CLI Entry Point (~100 LOC)

```
jh-gw auth          # Open browser, capture credentials, save to config
jh-gw serve         # Start gateway server on configured port
jh-gw serve -p 8080 # Override port
jh-gw config        # Print current config
jh-gw status        # Check Chrome connection + token expiry
```

---

## Technical Challenges & Mitigations

### 1. Buffered vs True Streaming

**Current state:** `page.evaluate()` collects the entire SSE response in-browser, then returns it as a single string to Node.js. This means the gateway cannot stream tokens to the client in real-time — it buffers the full response first.

**Mitigation options (ordered by complexity):**

1. **Keep buffered (Phase 1):** Simplest. The response arrives quickly (~2-10s for most prompts). Acceptable for initial version.

2. **Polling bridge (Phase 2):** Use `page.exposeFunction()` to create a callback from browser → Node. The in-browser fetch reader calls this function for each chunk, which the Node server immediately forwards as SSE.

3. **CDP Network.getResponseBody interception (Phase 3):** Use Playwright's `page.route()` or raw CDP `Network.streamResourceContent` to intercept the response at the network level and pipe chunks directly.

**Recommendation:** Start with option 1, iterate to option 2 for real-time streaming.

### 2. Cloudflare TLS Fingerprint

The `cf_clearance` cookie is bound to the browser's TLS fingerprint. Plain `node:fetch` cannot reproduce it. **This is why browser-based fetching is mandatory** — there is no workaround.

### 3. Concurrent Requests

The current client uses a single browser page. Simultaneous `/v1/chat/completions` requests would collide.

**Mitigation:** Implement a request queue with `Promise` serialization. For higher throughput, open multiple browser tabs (one per concurrent request) with a configurable pool size.

### 4. Token Expiry & Refresh

Bearer tokens from JH (Azure AD JWT) expire after ~1 hour. The gateway should:

- Check `exp` claim before each request
- On 401: auto re-capture via browser (page reload triggers authenticated request)
- Expose `/health` endpoint showing token TTL

### 5. Tool Call Fidelity

The XML-based tool call approach is a prompt injection technique — the model generates `<tool_call>` XML in its text output, which the parser extracts. This works well with Claude models but has inherent limitations:

- Model may not always follow the XML format perfectly
- Streaming tool calls arrive character-by-character (partial XML)
- The tag parser must buffer until a complete tag boundary is found

The existing `jh-web-stream.ts` tag parser handles all of these correctly and can be extracted as-is.

---

## Implementation Phases

### Phase 1: Scaffold + Auth + Basic Gateway (~1 day)

- [ ] Initialize project with `package.json`, `tsconfig.json`
- [ ] Implement `chrome-cdp.ts` (minimal CDP discovery)
- [ ] Implement `config.ts` (JSON config management)
- [ ] Implement `auth.ts` (browser credential capture)
- [ ] Implement `cli.ts` with `auth` command
- [ ] Basic `server.ts` with `/v1/models` endpoint
- [ ] Tests for config and auth

### Phase 2: Chat Completions (Non-Streaming) (~1 day)

- [ ] Implement `client.ts` (browser-based API client)
- [ ] Implement `stream-translator.ts` (JH SSE → text extraction)
- [ ] Wire `POST /v1/chat/completions` (non-streaming mode)
- [ ] Message flattening (OpenAI messages array → single prompt)
- [ ] Tests for client and translator

### Phase 3: Streaming + Tool Calls (~1 day)

- [ ] Add SSE streaming mode to `/v1/chat/completions`
- [ ] Implement `tool-parser.ts` (XML tag extraction)
- [ ] Tool prompt injection (OpenAI tools → XML instructions)
- [ ] Tool call response translation (XML → OpenAI tool_calls format)
- [ ] Think tag handling
- [ ] Tests for tool parsing and streaming

### Phase 4: Hardening (~0.5 day)

- [ ] 401 auto re-auth
- [ ] Cloudflare 403 detection
- [ ] Request queue for concurrency
- [ ] `/health` endpoint (token TTL, Chrome status)
- [ ] Graceful shutdown
- [ ] Error responses in OpenAI error format
- [ ] README with setup instructions

---

## Integration with OpenClaw

Once the standalone gateway is running (e.g., on `http://127.0.0.1:8741`), configure openclaw to use it as a standard OpenAI-compatible provider:

```json
// openclaw.json
{
  "models": {
    "providers": {
      "jh-gateway": {
        "baseUrl": "http://127.0.0.1:8741",
        "api": "openai",
        "models": [{ "id": "claude-opus-4.5", "name": "Claude Opus 4.5 (JH)" }]
      }
    }
  }
}
```

This replaces the current `jh-web` provider (custom API) with a standard `openai` API provider backed by the local gateway. No custom stream handler, client, or auth module needed in openclaw.

---

## Estimated Code Size

| Module                 | LOC (estimated) |
| ---------------------- | --------------- |
| `chrome-cdp.ts`        | ~60             |
| `config.ts`            | ~80             |
| `auth.ts`              | ~150            |
| `client.ts`            | ~300            |
| `stream-translator.ts` | ~250            |
| `tool-parser.ts`       | ~120            |
| `server.ts`            | ~200            |
| `cli.ts`               | ~100            |
| **Total**              | **~1,260**      |

Plus ~500 LOC of tests. Significantly smaller than the current scattered implementation (~1,400 LOC across 5+ files with deep framework coupling).

---

## Expanded Vision: Standalone API Manager Application

The gateway should feel like a **first-class local API server** — comparable to LM Studio, LiteLLM Proxy, or Jan — not a developer-only CLI tool. This means:

1. **Painless onboarding** — guided setup, not manual config editing
2. **Easy distribution** — single download, no monorepo checkout
3. **Full OpenAI API parity** — images, tool calls, streaming, multi-turn, system messages
4. **Management dashboard** — status, logs, model selection, token health

---

## Onboarding UX

### Option 1: Interactive TUI Wizard (Recommended for v1)

A guided terminal wizard using [Clack](https://github.com/natemoo-re/clack) (same lib openclaw uses) or [Ink](https://github.com/vadimdemedes/ink):

```
$ jh-gateway setup

  ┌  JH Web Gateway — First-Time Setup
  │
  ◇  Step 1/4: Chrome Connection
  │  Looking for Chrome with remote debugging...
  │  ✓ Found Chrome at http://127.0.0.1:9222
  │
  ◇  Step 2/4: JH Authentication
  │  Opening chat.ai.jh.edu in your browser...
  │  Please log in if prompted, then send any message.
  │  ✓ Captured Bearer token (expires in 58 min)
  │  ✓ Captured session cookies (5 cookies)
  │
  ◇  Step 3/4: Gateway Port
  │  Which port should the API server listen on?
  │  › 8741 (default)
  │
  ◇  Step 4/4: Verify
  │  Testing connection to chat.ai.jh.edu...
  │  ✓ API responded with model list
  │  ✓ Claude Opus 4.5, Claude Sonnet 4.5, GPT-4o available
  │
  └  Setup complete!

  Your OpenAI-compatible API is ready:
    Base URL:  http://127.0.0.1:8741/v1
    API Key:   jh-local-xxxxx (auto-generated)

  Quick start:
    $ jh-gateway serve
    $ curl http://127.0.0.1:8741/v1/chat/completions \
        -H "Authorization: Bearer jh-local-xxxxx" \
        -d '{"model":"claude-opus-4.5","messages":[{"role":"user","content":"hello"}]}'
```

**Key UX principles:**

- **Auto-detect Chrome** — scan common CDP ports (9222, 9223) before asking
- **Zero manual config** — all values have sensible defaults
- **Verify before finishing** — actually test the connection end-to-end
- **Copy-pastable output** — print the base URL and a working curl command
- **Re-auth shortcut** — `jh-gateway auth` re-captures credentials without full setup

### Option 2: Built-In Web Dashboard (Recommended for v2)

The gateway server itself serves a management UI at its root (`http://127.0.0.1:8741/`):

```
┌─────────────────────────────────────────────────────┐
│  JH Web Gateway                          ● Running  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Status                                             │
│  ├ API:    http://127.0.0.1:8741/v1    [Copy]       │
│  ├ Token:  Valid (expires in 47 min)   [Refresh]    │
│  └ Chrome: Connected (CDP 9222)                     │
│                                                     │
│  Models                                             │
│  ☑ claude-opus-4.5    (AnthropicClaude)             │
│  ☑ claude-sonnet-4.5  (AnthropicClaude)             │
│  ☑ gpt-4o             (OpenAI)                      │
│  ☑ gemini-2.0-flash   (Google)                      │
│                                                     │
│  Recent Requests                                    │
│  12:03 POST /v1/chat/completions claude-opus  200   │
│  12:01 POST /v1/chat/completions gpt-4o       200   │
│  11:58 GET  /v1/models                        200   │
│                                                     │
│  Settings                                           │
│  Port: [8741]  Default Model: [claude-opus-4.5 ▾]   │
│  Gateway Auth: [Bearer token ▾]  Key: [••••••]      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Tech stack for the dashboard:**

- Single-page app served from the same Hono server
- Built with Preact + HTM (tiny, no build step needed) or a pre-built static bundle
- ~200-300 LOC of HTML/JS for the dashboard
- WebSocket for live request log updates
- REST API for settings/status (`GET /api/status`, `POST /api/settings`, `POST /api/auth/refresh`)

### Option 3: System Tray App (Future / v3)

For a native-feeling experience on macOS/Windows:

- **Tauri** (Rust + WebView) or **Electron** wrapper around the web dashboard
- System tray icon with status indicator (green = running, yellow = token expiring, red = disconnected)
- Menu: Start/Stop, Open Dashboard, Re-authenticate, Quit
- Auto-start on login (optional)
- ~2-3 day additional effort on top of v2

**Recommendation:** Ship v1 with TUI wizard + CLI. Add web dashboard in v2 (it's just static HTML served by the existing Hono server). Consider tray app only if there's demand.

---

## Distribution & Packaging

### Tier 1: npm Global Package (Day 1)

```bash
npm install -g jh-web-gateway
# or
npx jh-web-gateway setup
npx jh-web-gateway serve
```

- Requires Node.js 22+ (same as openclaw)
- Playwright-core auto-downloads Chromium only if needed (the gateway uses existing Chrome via CDP, so no download needed in normal flow)
- Smallest distribution effort — just publish to npm

### Tier 2: Standalone Binary (Week 1)

Use `bun build --compile` or Node SEA (Single Executable Application):

```bash
# macOS
curl -fsSL https://github.com/user/jh-web-gateway/releases/latest/download/jh-gateway-macos-arm64 -o jh-gateway
chmod +x jh-gateway
./jh-gateway setup
```

- Single binary, no Node.js installation required
- `bun build --compile` produces ~50-80MB binary (includes Bun runtime)
- Node SEA produces ~40-60MB binary
- GitHub Releases for macOS (arm64, x64), Linux (x64), Windows (x64)

### Tier 3: Homebrew (Week 2)

```bash
brew tap user/jh-web-gateway
brew install jh-gateway
```

- Formula points to GitHub Release binary
- Auto-updates via `brew upgrade`

### Tier 4: Docker (Week 2)

```bash
docker run -p 8741:8741 -v ~/.jh-gateway:/root/.jh-gateway ghcr.io/user/jh-web-gateway
```

- **Challenge:** Docker cannot attach to the host's Chrome via CDP without `--network=host` or explicit port forwarding
- Better suited for headless environments where Chrome also runs in Docker
- Less practical for the primary use case (local dev machine with existing Chrome)

### Packaging Comparison

| Method      | Size                   | Node Required | Auto-Update     | Effort  |
| ----------- | ---------------------- | ------------- | --------------- | ------- |
| npm global  | ~2 MB (+ node_modules) | Yes           | `npm update -g` | Trivial |
| Bun compile | ~60 MB                 | No            | Manual / brew   | 1 day   |
| Homebrew    | ~60 MB                 | No            | `brew upgrade`  | 0.5 day |
| Docker      | ~200 MB                | No            | `docker pull`   | 0.5 day |

**Recommendation:** Start with npm (zero effort), add Bun compile binary for GitHub Releases shortly after. Homebrew and Docker are nice-to-haves.

---

## Full API Feature Parity

The gateway should support the **complete OpenAI Chat Completions API** surface, not just basic text streaming. Here's the feature matrix:

### Core Features

| Feature         | OpenAI Spec                   | Gateway Support  | Implementation Notes                                         |
| --------------- | ----------------------------- | ---------------- | ------------------------------------------------------------ |
| Text messages   | `role: user/assistant/system` | ✅ Full          | Flatten to single prompt for JH                              |
| Streaming       | `stream: true`                | ✅ Full          | JH SSE → OpenAI SSE translation                              |
| Non-streaming   | `stream: false`               | ✅ Full          | Collect full response, return JSON                           |
| System messages | `role: system`                | ✅ Full          | Prepended to prompt                                          |
| Multi-turn      | Multiple messages             | ✅ Full          | Client-side context flattening                               |
| Model selection | `model: "claude-opus-4.5"`    | ✅ Full          | Maps to JH endpoint path                                     |
| Stop sequences  | `stop: ["\n"]`                | ⚠️ Partial       | Post-process truncation (JH API doesn't support native stop) |
| Temperature     | `temperature: 0.7`            | ❌ Not supported | JH platform doesn't expose this parameter                    |
| Max tokens      | `max_tokens: 1000`            | ❌ Not supported | JH platform doesn't expose this parameter                    |

### Tool Calls (Function Calling)

| Feature                   | OpenAI Spec                                    | Gateway Support | Implementation Notes                         |
| ------------------------- | ---------------------------------------------- | --------------- | -------------------------------------------- |
| Tool definitions          | `tools: [{type:"function",...}]`               | ✅ Full         | Injected as XML instructions in prompt       |
| Tool calls in response    | `tool_calls: [{id,function:{name,arguments}}]` | ✅ Full         | XML `<tool_call>` tags parsed from stream    |
| Streaming tool calls      | Delta chunks with `tool_calls`                 | ✅ Full         | Tag parser emits incremental deltas          |
| Parallel tool calls       | Multiple tool_calls in one response            | ✅ Full         | Parser handles sequential `<tool_call>` tags |
| Tool results              | `role: "tool"` messages                        | ✅ Full         | Formatted as `<tool_response>` XML in prompt |
| `tool_choice: "auto"`     | Let model decide                               | ✅ Default      | Model decides based on prompt                |
| `tool_choice: "required"` | Force tool use                                 | ⚠️ Best-effort  | Add "you MUST use a tool" to prompt          |
| `tool_choice: {name}`     | Force specific tool                            | ⚠️ Best-effort  | Add "you MUST use tool X" to prompt          |

### Image/Vision Support

The JH platform (LibreChat-based) has file upload capabilities. The payload already includes `resendFiles: true` and `ephemeralAgent.file_search`. Image support requires research into the platform's file upload API.

| Feature         | OpenAI Spec                                     | Gateway Support | Implementation Notes                                |
| --------------- | ----------------------------------------------- | --------------- | --------------------------------------------------- |
| Base64 images   | `image_url: {url: "data:image/png;base64,..."}` | ✅ Planned      | Upload to JH via `/api/files`, reference in message |
| URL images      | `image_url: {url: "https://..."}`               | ⚠️ Planned      | Download, then upload to JH                         |
| Multiple images | Array of image_url parts                        | ✅ Planned      | Upload each, reference all                          |
| Image detail    | `detail: "high" / "low" / "auto"`               | ❌ Pass-through | JH doesn't expose detail control                    |

**Image upload pipeline:**

```
Client sends base64 image in OpenAI format
  → Gateway decodes base64
  → Gateway uploads to JH via POST /api/files (browser fetch, Cloudflare bypass)
  → JH returns file_id
  → Gateway includes file_id reference in chat payload
  → JH model processes image + text
```

This requires reverse-engineering the JH file upload endpoint (likely `POST /api/files` based on LibreChat conventions). The `resendFiles: true` flag in the existing payload suggests the platform supports re-sending previously uploaded files.

### Additional Endpoints

| Endpoint                      | OpenAI Spec        | Gateway Support | Notes                               |
| ----------------------------- | ------------------ | --------------- | ----------------------------------- |
| `GET /v1/models`              | List models        | ✅ Full         | Static list from model-endpoint map |
| `POST /v1/chat/completions`   | Chat               | ✅ Full         | Core endpoint                       |
| `POST /v1/completions`        | Legacy completions | ⚠️ Shim         | Wrap as single-turn chat            |
| `POST /v1/embeddings`         | Embeddings         | ❌ N/A          | JH doesn't expose embedding API     |
| `POST /v1/images/generations` | Image gen          | ❌ N/A          | Not applicable                      |
| `GET /v1/models/{id}`         | Model detail       | ✅ Easy         | Return static model info            |
| `GET /health`                 | Health check       | ✅ Custom       | Token TTL, Chrome status            |

### Gateway-Level Auth & Security

The gateway itself needs auth to prevent unauthorized local access:

```typescript
interface GatewayAuth {
  mode: "none" | "bearer" | "basic";
  // Auto-generated on setup, stored in config
  token?: string;
  // Optional: restrict to specific IPs
  allowedIps?: string[];
}
```

- **Default:** Auto-generated bearer token printed during setup
- **Loopback-only bind by default** (127.0.0.1) — safe without auth
- **Network bind requires auth** — refuse to start without a token if binding to 0.0.0.0
- **Rate limiting** — configurable per-IP rate limits

### Request/Response Logging

Every request through the gateway is logged with:

- Timestamp, method, path, model, status code, latency
- Token usage estimates (approximate from character count)
- Stored in `~/.jh-gateway/logs/` as JSONL
- Queryable via dashboard or `jh-gateway logs` CLI command

---

## Revised Architecture

```
jh-web-gateway/
├── src/
│   ├── cli.ts                # Entry: setup, serve, auth, status, logs, config
│   ├── server.ts             # Hono HTTP server (API + dashboard)
│   ├── routes/
│   │   ├── chat-completions.ts  # POST /v1/chat/completions
│   │   ├── models.ts            # GET /v1/models, GET /v1/models/:id
│   │   ├── health.ts            # GET /health
│   │   └── dashboard.ts         # GET / (web dashboard static files)
│   ├── core/
│   │   ├── auth-capture.ts      # Browser CDP attach → capture Bearer + cookies
│   │   ├── client.ts            # In-browser fetch client (Cloudflare bypass)
│   │   ├── stream-translator.ts # JH SSE → OpenAI SSE/JSON
│   │   ├── tool-parser.ts       # XML <tool_call>/<think> tag extraction
│   │   ├── image-upload.ts      # Image handling: base64 → JH file upload
│   │   ├── message-builder.ts   # OpenAI messages → JH prompt flattening
│   │   └── request-queue.ts     # Serialize concurrent requests
│   ├── infra/
│   │   ├── chrome-cdp.ts        # Minimal CDP: discover WS URL, connect
│   │   ├── config.ts            # ~/.jh-gateway/config.json management
│   │   ├── gateway-auth.ts      # Local gateway bearer/basic auth
│   │   ├── logger.ts            # Request logging (JSONL)
│   │   └── types.ts             # Shared types
│   └── dashboard/
│       └── index.html           # Single-file web dashboard (Preact + HTM)
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

### Dependencies (updated)

```json
{
  "dependencies": {
    "playwright-core": "^1.52",
    "hono": "^4.7",
    "@hono/node-server": "^1.14",
    "ws": "^8.18",
    "@clack/prompts": "^0.10"
  },
  "devDependencies": {
    "typescript": "^5.8",
    "vitest": "^3.1",
    "tsup": "^8.4"
  }
}
```

Still zero `@mariozechner/pi-*` or openclaw packages.

---

## Revised Implementation Phases

### Phase 1: Scaffold + TUI Setup + Basic Server (~1.5 days)

- [ ] Initialize project (`package.json`, `tsconfig.json`, `vitest.config.ts`)
- [ ] `infra/chrome-cdp.ts` — minimal CDP discovery
- [ ] `infra/config.ts` — JSON config management (`~/.jh-gateway/config.json`)
- [ ] `core/auth-capture.ts` — browser credential capture
- [ ] `cli.ts` — `setup` wizard (TUI with Clack), `auth`, `config`, `status`
- [ ] `server.ts` — Hono server skeleton
- [ ] `routes/models.ts` — `GET /v1/models`
- [ ] `routes/health.ts` — `GET /health` (token TTL, Chrome status)
- [ ] `infra/gateway-auth.ts` — bearer token auth middleware
- [ ] Tests for config, auth-capture, models endpoint

### Phase 2: Chat Completions (Text) (~1.5 days)

- [ ] `core/client.ts` — browser-based API client with Cloudflare bypass
- [ ] `core/message-builder.ts` — OpenAI messages array → JH flat prompt
- [ ] `core/stream-translator.ts` — JH SSE → text extraction
- [ ] `routes/chat-completions.ts` — `POST /v1/chat/completions` (non-streaming + streaming)
- [ ] `core/request-queue.ts` — serialize concurrent requests
- [ ] `infra/logger.ts` — JSONL request logging
- [ ] Tests for message builder, stream translator, chat endpoint

### Phase 3: Tool Calls + Thinking (~1 day)

- [ ] `core/tool-parser.ts` — XML `<tool_call>`/`<think>` tag extraction
- [ ] Tool prompt injection — OpenAI `tools` array → XML instructions in system prompt
- [ ] Tool call response translation — XML tags → OpenAI `tool_calls` delta chunks
- [ ] Tool result handling — `role: "tool"` messages → `<tool_response>` XML
- [ ] `tool_choice` support (auto, required, specific)
- [ ] Think tag → strip or include as reasoning
- [ ] Tests for tool parsing, round-trip tool call flow

### Phase 4: Image Support (~1 day)

- [ ] Reverse-engineer JH file upload API (`POST /api/files` or similar)
- [ ] `core/image-upload.ts` — base64/URL image → JH file upload via browser fetch
- [ ] Wire image_url parts from OpenAI messages → upload → reference in chat payload
- [ ] Image size/count limits and validation
- [ ] Tests for image pipeline

### Phase 5: Dashboard + Polish (~1 day)

- [ ] `dashboard/index.html` — single-file web UI (Preact + HTM, no build step)
- [ ] `routes/dashboard.ts` — serve static dashboard + WebSocket for live logs
- [ ] Dashboard features: status, models, request log, settings, auth refresh
- [ ] `cli.ts` — add `serve` with `--open` flag to auto-open dashboard in browser
- [ ] `cli.ts` — add `logs` command for querying request history

### Phase 6: Distribution (~0.5 day)

- [ ] `tsup` build config for single-file bundle
- [ ] `bun build --compile` script for standalone binary
- [ ] GitHub Actions workflow: build + publish npm + release binaries
- [ ] Homebrew formula
- [ ] README with installation options, quickstart, screenshots

### Phase 7: Hardening (~0.5 day)

- [ ] 401 auto re-auth with retry
- [ ] Cloudflare 403 challenge detection + user-friendly error
- [ ] Token TTL monitoring + proactive warning via dashboard/logs
- [ ] Graceful shutdown (close Chrome connection, drain requests)
- [ ] Network bind safety (refuse 0.0.0.0 without auth)
- [ ] Rate limiting middleware
- [ ] Error responses in full OpenAI error format

---

## How It Fits Together: User Journey

### First-Time User

```
1. Install:     npm i -g jh-web-gateway
                (or download binary from GitHub Releases)

2. Start Chrome: google-chrome --remote-debugging-port=9222
                 (or use existing Chrome with debug flag)

3. Setup:       jh-gateway setup
                → TUI wizard detects Chrome, opens JH login,
                  captures creds, picks port, verifies connection

4. Run:         jh-gateway serve
                → Server starts at http://127.0.0.1:8741/v1
                → Dashboard available at http://127.0.0.1:8741/

5. Connect:     Point any OpenAI-compatible client to:
                  Base URL: http://127.0.0.1:8741/v1
                  API Key:  (from setup output)
```

### Returning User

```
1. jh-gateway serve          # Start server (creds loaded from config)
2. Token expires?            # Auto re-auth via browser, or:
   jh-gateway auth           # Manual re-auth
3. Dashboard shows status, logs, token TTL at http://127.0.0.1:8741/
```

### OpenClaw Integration

```json
// openclaw.json — just a standard OpenAI provider
{
  "models": {
    "providers": {
      "jh": {
        "baseUrl": "http://127.0.0.1:8741",
        "api": "openai",
        "apiKey": "jh-local-xxxxx",
        "models": [
          { "id": "claude-opus-4.5", "name": "Claude Opus 4.5 (JH)" },
          { "id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5 (JH)" },
          { "id": "gpt-4o", "name": "GPT-4o (JH)" }
        ]
      }
    }
  }
}
```

### Other Client Integration Examples

**Continue (VS Code):**

```json
// ~/.continue/config.json
{
  "models": [
    {
      "provider": "openai",
      "title": "Claude via JH",
      "model": "claude-opus-4.5",
      "apiBase": "http://127.0.0.1:8741/v1",
      "apiKey": "jh-local-xxxxx"
    }
  ]
}
```

**Cursor:**

```
Settings → Models → OpenAI API Key: jh-local-xxxxx
Settings → Models → Override OpenAI Base URL: http://127.0.0.1:8741/v1
```

**aider:**

```bash
aider --openai-api-base http://127.0.0.1:8741/v1 \
      --openai-api-key jh-local-xxxxx \
      --model claude-opus-4.5
```

**Python (openai SDK):**

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8741/v1", api_key="jh-local-xxxxx")
response = client.chat.completions.create(
    model="claude-opus-4.5",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content, end="")
```
