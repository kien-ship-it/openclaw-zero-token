# Analysis of chat.ai.jh.edu for OpenClaw Zero Token Integration

This document outlines the authentication, payload, and streaming characteristics for the target web UI (`https://chat.ai.jh.edu`), based on HTTP request and response analysis. This information is a prerequisite for creating the appropriate auth modules, API clients, and stream handlers in the `openclaw-zero-token` repository.

## Phase 1: Authentication Category

**Category:** Cookie + Dynamic Header

To successfully authenticate with the `chat.ai.jh.edu` API, both cookies and a dynamic Bearer token must be intercepted and provided with every request.

- **Cookies:** The platform uses multiple cookies for session management and bot protection. Key cookies include:
  - `cf_clearance`: Cloudflare bot protection cookie.
  - `connect.sid`: Standard session ID.
  - `token_provider`, `refreshToken`, `openid_user_id`: Identity and session tokens.
- **Authorization Header:** The API requires an `Authorization: Bearer <token>` header, where the token is a JWT signed by Windows STS/Azure AD (specifically for Johns Hopkins University).
- **Implications for Auth Module:** Due to the presence of Cloudflare (`cf_clearance`), an automated headless login might be blocked. The auth module (`src/providers/jh-web-auth.ts`) will likely require an "Attach to Existing Browser" approach where the user logs in manually, and Playwright intercepts the network requests to capture both the `Bearer` token and the full cookie string.

```
POST /api/agents/chat/AnthropicClaude HTTP/1.1
Accept: */*
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: en-US,en;q=0.9
Authorization: Bearer <REDACTED_JWT_TOKEN>
Cache-Control: no-cache
Connection: keep-alive
Content-Length: 973
Content-Type: application/json
Cookie: cf_clearance=<REDACTED>; connect.sid=<REDACTED>; token_provider=openid; refreshToken=<REDACTED>; openid_user_id=<REDACTED>
Host: chat.ai.jh.edu
Origin: https://chat.ai.jh.edu
Pragma: no-cache
Referer: https://chat.ai.jh.edu/c/18dc6a04-2c72-4254-92c6-0bd666ef5e38
Sec-Fetch-Dest: empty
Sec-Fetch-Mode: cors
Sec-Fetch-Site: same-origin
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36
sec-ch-ua: "Chromium";v="145", "Not:A-Brand";v="99"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "macOS"
```

## Phase 2: Chat Request Category

**Category:** Stateful & Proprietary

The API does not follow the standard OpenAI format (`messages` array) and instead requires a proprietary payload with specific metadata.

- **Endpoint:** `POST /api/agents/chat/AnthropicClaude`
- **Payload Structure:** A flat JSON object containing the user's text and various metadata fields.

  ```json
  {
    "text": "hi",
    "sender": "User",
    "clientTimestamp": "2026-03-13T13:27:33",
    "isCreatedByUser": true,
    "parentMessageId": "3a23460c-9d91-4571-8e04-da7503b45c81",
    "conversationId": "18dc6a04-2c72-4254-92c6-0bd666ef5e38",
    "messageId": "16a6cfde-c0bd-449e-a92a-8e3ff1ea424d",
    "error": false,
    "endpoint": "AnthropicClaude",
    "endpointType": "custom",
    "model": "claude-opus-4.5",
    "resendFiles": true,
    "greeting": "...",
    "key": "never",
    "modelDisplayLabel": "Claude",
    "isTemporary": false,
    "isRegenerate": false,
    "isContinued": false,
    "ephemeralAgent": {
      "execute_code": false,
      "web_search": false,
      "file_search": false,
      "artifacts": false,
      "mcp": []
    }
  }
  ```

- **Implications for API Client:** The `src/providers/jh-web-client.ts` client must format standard OpenClaw messages into this structure. Specifically, it will need to:
  - Generate random UUIDs for `parentMessageId`, `conversationId`, and `messageId` using `crypto.randomUUID()`.
  - Inject the correct timestamp (`clientTimestamp`).
  - Flatten the conversation history into a single string for the `text` field, or implement logic to handle stateful conversation IDs if multi-turn context must be managed on the server side - context will be handled client-side.

## Phase 3: Streaming Category

**Category:** Server-Sent Events (SSE) / Custom JSON (LibreChat-based)

The platform streams responses back using SSE with a **two-layer event structure**. All SSE lines use `event: message`, but the JSON payload contains its own `event` field that distinguishes the actual event type.

- **Content-Type:** `text/event-stream`
- **SSE line:** Always `event: message` (the SSE event name is constant).
- **JSON event field:** The real event type is in the parsed JSON's `event` key.

### SSE Event Sequence (observed live)

1. **User echo** (first event) -- skip this:

   ```
   event: message
   data: {"message":{"messageId":"...","sender":"User","text":"<full user prompt>","isCreatedByUser":true},"created":true}
   ```

2. **Run step** -- metadata, skip:

   ```
   event: message
   data: {"event":"on_run_step","data":{"stepIndex":0,"id":"step_...","type":"message_creation",...}}
   ```

3. **Message deltas** (repeated, ~30 events) -- **extract text from these**:

   ```
   event: message
   data: {"event":"on_message_delta","data":{"id":"step_...","delta":{"content":[{"type":"text","text":"Hello"}]}}}
   ```

4. **Final summary** (last event) -- carries `responseMessage` with full accumulated text + metadata:
   ```
   event: message
   data: {"message":{...user echo...},"responseMessage":{"sender":"Claude","isCreatedByUser":false,"text":"","content":[{"type":"text","text":"<full response>"}]}}
   ```

### Parser Logic

The `src/agents/jh-web-stream.ts` module must:

1. Check the JSON `event` field **first** (not the SSE `event:` line, which is always `message`).
2. For `event: "on_message_delta"`: extract text from `data.delta.content[].text`.
3. For payloads with a `message` key: skip if `message.isCreatedByUser === true` or `message.sender === "User"`.
4. Ignore `on_run_step` and other metadata events.

---

## Validation Notes

Cross-referencing against existing web-provider patterns in the codebase (`claude-web-*`, `deepseek-web-*`, `chatgpt-web-*`, etc.).

### Confirmed Correct

- **File paths** align with conventions: auth in `src/providers/`, stream in `src/agents/`, client in `src/providers/`.
- **"Attach to Existing Browser" auth approach** matches `claude-web-auth.ts` (Playwright CDP attach, intercept network).
- **Proprietary payload** analysis is accurate; the flat JSON with UUIDs and `clientTimestamp` is non-OpenAI and requires a custom client.
- **SSE with custom JSON** streaming category is correct; the `on_message_delta` event structure needs a dedicated parser.
- **Client-side context flattening** decision (single `text` field) is the right call for simplicity.

### Corrections (discovered during implementation)

1. **SSE event line is always `message`**, not `on_message_delta`. The original analysis assumed the SSE `event:` line would carry the event type, but all events use `event: message`. The real event type is in the JSON payload's `event` field.
2. **First SSE event is a user echo.** The server echoes back the user's own message (with `isCreatedByUser: true`, `sender: "User"`) before sending the AI response. The parser must skip this.
3. **Response is buffered, not truly streaming from the browser.** Because the API client runs inside `page.evaluate()` (Playwright browser context), the full SSE response is collected in-browser and returned as a single string. The stream handler still parses it line-by-line on the Node side.
4. **Model resolution requires explicit provider config in `openclaw.json`.** The `PiModelRegistry` (pi-coding-agent) does not recognize custom web providers. The fallback path in `resolveModelWithRegistry` checks `cfg.models.providers["jh-web"]`, so the provider must be registered in `openclaw.json` (not just `models.json`).

### Gaps and Additions

1. **Browser client variant missing.** ✅ Implemented as `src/providers/jh-web-client-browser.ts` -- the primary client, since `cf_clearance` cookies are tied to TLS fingerprints that plain `fetch` cannot reproduce.

2. **Auth-choice registration not mentioned.** ✅ Wired into:
   - `src/commands/auth-choice.apply.jh-web.ts`
   - `src/commands/onboard-auth.config-core.ts` (config applier)
   - `src/commands/onboard-auth.credentials.ts` (credential storage)
   - `src/commands/onboard-web-auth.ts` (model aliases + provider model IDs)

3. **Token refresh strategy.** ✅ Implemented option **(a)**: auto re-auth via browser on 401. The client detects expired tokens, triggers `loginJhWeb` to re-capture credentials from the live browser session, then retries the request once.

4. **Model registration.** ✅ Registered in:
   - `src/agents/models-config.providers.ts` (`buildJhWebProvider()` + `resolveAllProviders` registration)
   - `.openclaw-upstream-state/openclaw.json` (`models.providers.jh-web` with model definitions)

5. **Security: redact sample credentials.** ✅ All live JWTs, cookies, and PII replaced with `<REDACTED>` placeholders.

---

## Implementation Plan

### Phase 0: Scaffold and Security Hygiene (DONE)

**Goal:** Set up file scaffolds and redact sensitive data.

| Step | Action                                                                                                                               | File(s)                                                                                                                                             | Status |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0.1  | Redact all live tokens, cookies, JWTs, and PII from this document. Replace with `<REDACTED>` placeholders keeping structure visible. | `.documentation/chat-ai-jh-edu-analysis.md`                                                                                                         | ✅     |
| 0.2  | Create empty scaffold files for the provider integration.                                                                            | `src/providers/jh-web-auth.ts`, `src/providers/jh-web-client-browser.ts`, `src/agents/jh-web-stream.ts`, `src/commands/auth-choice.apply.jh-web.ts` | ✅     |
| 0.3  | Add `JH_WEB_BEARER_TOKEN` and `JH_WEB_COOKIE` to `.env.example` with placeholder descriptions.                                       | `.env.example`                                                                                                                                      | ✅     |

**Checkpoint 0:** All scaffold files exist, no secrets in docs, `.env.example` updated. `pnpm build` still passes (empty files export nothing yet).

---

### Phase 1: Auth Module

**Goal:** Capture Bearer token + cookies from a live browser session via Playwright CDP.

| Step | Action                                                                                                                                                                                                                              | File(s)                                    | Status |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| 1.1  | Define `JhWebAuth` interface: `{ bearerToken: string; cookie: string; userAgent: string; }`.                                                                                                                                        | `src/providers/jh-web-auth.ts`             | ✅     |
| 1.2  | Implement `loginJhWeb(params)` following the `loginClaudeWeb` pattern: launch/attach Chrome, navigate to `https://chat.ai.jh.edu`, intercept `Authorization` header and `Cookie` header from any `POST /api/agents/chat/*` request. | `src/providers/jh-web-auth.ts`             | ✅     |
| 1.3  | Add JWT expiry extraction helper: decode the Bearer JWT payload, read `exp`, and expose `getTokenExpiresAt(bearerToken): number`.                                                                                                   | `src/providers/jh-web-auth.ts`             | ✅     |
| 1.4  | Wire credential storage: `setJhWebCredentials(auth, agentDir)` and `getJhWebCredentials(agentDir)`.                                                                                                                                 | `src/commands/onboard-auth.credentials.ts` | ✅     |
| 1.5  | Write unit test for JWT expiry extraction (mock JWT, verify timestamp).                                                                                                                                                             | `src/providers/jh-web-auth.test.ts`        | ✅     |

**Checkpoint 1:** `loginJhWeb` can be invoked manually (e.g., via a temp script), captures auth, stores credentials, and `pnpm test -- jh-web-auth` passes.

---

### Phase 2: API Client (Browser-based) (DONE)

**Goal:** Send chat requests using the proprietary payload format through a Playwright-managed browser page, bypassing Cloudflare TLS fingerprint checks.

| Step | Action                                                                                                                                                                             | File(s)                                       | Status |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------ |
| 2.1  | Define `JhWebClientOptions`: `{ bearerToken, cookie, userAgent, model? }`.                                                                                                         | `src/providers/jh-web-client-browser.ts`      | ✅     |
| 2.2  | Implement `JhWebClientBrowser` class with `init()` (CDP attach) and `chatCompletions(params)` method. Builds the flat proprietary JSON and POSTs to `/api/agents/chat/{endpoint}`. | `src/providers/jh-web-client-browser.ts`      | ✅     |
| 2.3  | Handle conversation state: maintain `parentMessageId` chain across turns within a session using an in-memory `Map<sessionKey, { conversationId, lastParentMessageId }>`.           | `src/providers/jh-web-client-browser.ts`      | ✅     |
| 2.4  | Add model-endpoint mapping: `{ "claude-opus-4.5": "AnthropicClaude", ... }` so the endpoint path is derived from the selected model.                                               | `src/providers/jh-web-client-browser.ts`      | ✅     |
| 2.5  | Add token-expiry guard: before each request, check `getTokenExpiresAt()`. If within 5 min of expiry, log a warning. If expired, throw a descriptive error prompting re-auth.       | `src/providers/jh-web-client-browser.ts`      | ✅     |
| 2.6  | Write unit test for payload construction (mock inputs, assert JSON shape matches spec).                                                                                            | `src/providers/jh-web-client-browser.test.ts` | ✅     |

**Checkpoint 2:** `JhWebClientBrowser.sendMessage("hello")` returns a raw `ReadableStream` / `Response` from the server. Payload matches the spec from Phase 2 of the analysis. Unit tests pass.

---

### Phase 3: Stream Handler (DONE)

**Goal:** Parse the SSE response into OpenClaw's `AssistantMessage` event stream.

| Step | Action                                                                                                                                                                                                          | File(s)                            | Status |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------ |
| 3.1  | Implement `createJhWebStreamFn(credentialJson: string): StreamFn` following the `createClaudeWebStreamFn` pattern.                                                                                              | `src/agents/jh-web-stream.ts`      | ✅     |
| 3.2  | SSE parser: read the `text/event-stream` response line-by-line, parse JSON chunks, filter for `event === "on_message_delta"`.                                                                                   | `src/agents/jh-web-stream.ts`      | ✅     |
| 3.3  | Delta extraction: extract text from `chunk.data.delta.content[0].text`, emit via `stream.emitContentDelta(text)`. Handle array content blocks (iterate all `content` items of `type === "text"`).               | `src/agents/jh-web-stream.ts`      | ✅     |
| 3.4  | Stream lifecycle: emit `stream.emitMessageStart()` on first delta, emit `stream.emitMessageEnd(assistantMessage)` on stream close using `buildAssistantMessageWithZeroUsage()` from `stream-message-shared.ts`. | `src/agents/jh-web-stream.ts`      | ✅     |
| 3.5  | Error handling: catch SSE parse errors and network errors, emit `buildStreamErrorAssistantMessage()` and close stream gracefully.                                                                               | `src/agents/jh-web-stream.ts`      | ✅     |
| 3.6  | Write unit tests with mock SSE payloads: (a) single delta, (b) multi-chunk stream, (c) malformed JSON, (d) empty stream.                                                                                        | `src/agents/jh-web-stream.test.ts` | ✅     |

**Checkpoint 3:** A mock SSE stream is correctly parsed into `AssistantMessage` events. `pnpm test -- jh-web-stream` passes. Manual end-to-end test: `loginJhWeb` → `sendMessage` → `createJhWebStreamFn` → streamed text output to console.

---

### Phase 4: Onboarding and Registration (DONE)

**Goal:** Wire the provider into the CLI onboarding flow and model selection system.

| Step | Action                                                                                                                                                                                            | File(s)                                                  | Status |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------ |
| 4.1  | Add `"jh-web"` auth choice to the auth-choice type enum and selection list.                                                                                                                       | `src/commands/auth-choice.ts`                            | ✅     |
| 4.2  | Implement `applyAuthChoiceJhWeb(params)` following the `applyAuthChoiceClaudeWeb` pattern: prompt for auto/manual mode, call `loginJhWeb` or accept manual cookie+token paste, store credentials. | `src/commands/auth-choice.apply.jh-web.ts`               | ✅     |
| 4.3  | Add `applyJhWebConfig(config)` config applier that sets `models.providers.jh-web` with `baseUrl: "https://chat.ai.jh.edu"` and default model.                                                     | `src/commands/onboard-auth.config-core.ts`               | ✅     |
| 4.4  | Register `jh-web` as a provider in `models-config.providers.ts` via `buildJhWebProvider()` + `resolveAllProviders`. Also requires entry in `openclaw.json` `models.providers`.                    | `src/agents/models-config.providers.ts`, `openclaw.json` | ✅     |
| 4.5  | Wire the stream function: `createJhWebStreamFn` is resolved when `provider === "jh-web"` in the embedded runner's stream dispatch.                                                                | `src/agents/pi-embedded-runner/run/attempt.ts`           | ✅     |
| 4.6  | Add `JH_WEB_BEARER_TOKEN` to `PROVIDER_ENV_API_KEY_CANDIDATES` map for env-based auth fallback.                                                                                                   | `src/agents/model-auth-env-vars.ts`                      | ✅     |

**Checkpoint 4:** `openclaw auth` shows "JH Web" as an option. Selecting it runs the browser login flow (or manual paste). After auth, `openclaw chat -m jh-web/claude-opus-4.5` sends a message and streams the response. `pnpm build` and `pnpm test` pass.

---

### Phase 5: Hardening and Polish

**Goal:** Production-readiness, edge cases, and documentation.

| Step | Action                                                                                                                                                                                 | File(s)                                  | Status |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------ |
| 5.1  | Token refresh: implement auto-re-auth by detecting 401 responses, triggering `loginJhWeb` re-capture, and retrying the request once.                                                   | `src/providers/jh-web-client-browser.ts` | ✅     |
| 5.2  | Cloudflare challenge handling: detect `cf_clearance` expiry (403 with challenge page), log actionable error message.                                                                   | `src/providers/jh-web-client-browser.ts` | ✅     |
| 5.3  | Multi-model support: test and add additional endpoint mappings beyond `AnthropicClaude` (e.g., if the platform offers GPT or other models under different `/api/agents/chat/*` paths). | `src/providers/jh-web-client-browser.ts` | ✅     |
| 5.4  | Conversation management: add optional `conversationId` reuse for multi-turn context managed server-side (currently client-side flattening).                                            | `src/providers/jh-web-client-browser.ts` | ✅     |
| 5.5  | Add integration/E2E test (gated behind `LIVE=1`).                                                                                                                                      | `src/agents/jh-web-stream.live.test.ts`  | ✅     |
| 5.6  | Documentation: update `docs/` with JH Web provider setup instructions.                                                                                                                 | `docs/providers/jh-web.md`               | ✅     |

**Checkpoint 5:** 401/403 errors are handled gracefully. Multiple models work. Live test passes with real credentials. Docs are published.

---

## Post-Implementation: Bugs Found and Fixed

During integration testing, several issues were discovered and resolved:

### Bug 1: Auth capture too restrictive

**Symptom:** `loginJhWeb` hung waiting for credentials.
**Root cause:** Request interception only captured credentials from `POST /api/agents/chat/*` requests, requiring the user to send a chat message. If the user was already logged in, no such request was made.
**Fix:** Broadened interception to capture `Authorization: Bearer` headers from ANY request to `chat.ai.jh.edu`. Added cookie polling and existing-session detection with page reload to trigger authenticated API requests.

### Bug 2: `model_not_found` at runtime

**Symptom:** `Unknown model: jh-web/claude-opus-4.5 (model_not_found)` despite model appearing in `/model status`.
**Root cause:** `PiModelRegistry` (from `@mariozechner/pi-coding-agent`) does not recognize custom web providers. The fallback path in `resolveModelWithRegistry` checks `cfg.models.providers["jh-web"]`, but `openclaw.json` had `"providers": {}`. The `models.json` file (used by `/model status`) had the provider, but the runtime model resolver needs it in the OpenClawConfig too.
**Fix:** Added the `jh-web` provider definition (baseUrl, api, models) to `openclaw.json` under `models.providers`.

### Bug 3: SSE parser returned user's own message

**Symptom:** OpenClaw UI displayed the system prompt text instead of the AI response.
**Root cause:** All SSE events use `event: message` as the SSE line. The parser checked `currentEventName === "message"` which matched ALL events, entering the Format A handler and returning early -- never reaching the `on_message_delta` handler. The first event (user echo) was parsed as the response.
**Fix:** Rewrote the parser to check the JSON payload's `event` field first. `on_message_delta` events are now processed for their `data.delta.content[].text` deltas before the `message`-key handler runs. User echo events are skipped via `isCreatedByUser === true || sender === "User"`.
