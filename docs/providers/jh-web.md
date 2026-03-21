---
summary: "Use Johns Hopkins HopGPT (chat.ai.jh.edu) with OpenClaw"
read_when:
  - You want to use JH HopGPT models in OpenClaw
  - You are a Johns Hopkins affiliate and want browser-based AI access
title: "JH Web (HopGPT)"
---

# JH Web (HopGPT)

The **JH Web** provider connects OpenClaw to [chat.ai.jh.edu](https://chat.ai.jh.edu), the
Johns Hopkins University AI platform (HopGPT). Access is restricted to JH affiliates with
valid institutional credentials.

## How authentication works

HopGPT uses a combination of:

- **Bearer JWT** – issued by Azure AD / Windows STS, valid for ~66 minutes.
- **Session cookies** – including a Cloudflare `cf_clearance` cookie tied to TLS fingerprint.

Because of the Cloudflare protection, OpenClaw uses a **Playwright browser-attach approach**:
it connects to a running Chrome instance via CDP, intercepts a real API request you trigger,
and captures the Bearer token and cookies automatically.

## Setup

### 1. Start Chrome in debug mode

```bash
./start-chrome-debug.sh
```

Or, if you prefer manual control:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/openclaw-chrome-profile
```

### 2. Run onboarding

```bash
openclaw onboard --auth-choice jh-web
```

> **Running from source?** Use `pnpm openclaw onboard --auth-choice jh-web` instead of
> `openclaw` directly (the global binary is only available after `npm install -g openclaw`).

The `--auth-choice jh-web` flag skips the provider picker and goes directly to the JH Web
auth flow. If you run `openclaw onboard` without the flag, scroll to the bottom of the
provider list to find **JH Web (chat.ai.jh.edu)**.

OpenClaw will open `chat.ai.jh.edu` in the attached browser. Log in with your JH credentials,
then send any message. OpenClaw intercepts the outbound request and captures your token
automatically.

### 3. Chat

```bash
openclaw chat -m jh-web/claude-opus-4.5 "Hello from OpenClaw"
```

## Available models

| Model ID                   | Endpoint          | Notes                              |
| -------------------------- | ----------------- | ---------------------------------- |
| `jh-web/claude-opus-4.5`   | `AnthropicClaude` | Default                            |
| `jh-web/claude-sonnet-4.5` | `AnthropicClaude` |                                    |
| `jh-web/claude-haiku-4.5`  | `AnthropicClaude` |                                    |
| `jh-web/gpt-4o`            | `OpenAI`          | If enabled on your HopGPT instance |
| `jh-web/gpt-4o-mini`       | `OpenAI`          | If enabled on your HopGPT instance |
| `jh-web/gemini-2.0-flash`  | `Google`          | If enabled on your HopGPT instance |

## Token expiry and refresh

The Bearer JWT expires in approximately 66 minutes. OpenClaw handles expiry automatically:

- **Expiry warning**: logged when fewer than 5 minutes remain.
- **Auto re-auth**: on a `401` response, OpenClaw re-opens the browser login flow and retries
  the request once with fresh credentials.
- **Cloudflare expiry**: if the `cf_clearance` cookie expires (you will see a `403` with a
  challenge page), OpenClaw will display an actionable error. Open `chat.ai.jh.edu` in Chrome,
  complete the Cloudflare challenge, then re-run onboarding.

## Environment variable fallback

For scripted/non-interactive use you can supply credentials via env vars:

```bash
export JH_WEB_BEARER_TOKEN="eyJ..."
export JH_WEB_COOKIE="cf_clearance=...; connect.sid=...; ..."
```

## Config snippet

```json5
{
  agents: { defaults: { model: { primary: "jh-web/claude-opus-4.5" } } },
}
```

## Notes

- All chats are **purged after 30 days** per the
  [HopGPT data retention policy](https://hopgpt.it.jh.edu/data-retention-notice/).
- Use must comply with the [HopGPT Terms of Use](https://hopgpt.it.jh.edu/terms/).
- This provider is zero-token: no OpenClaw API key is needed. Authentication is handled
  entirely through your JH institutional login.
- Multi-turn context is managed client-side (conversation history is flattened into the
  `text` field on each request).
