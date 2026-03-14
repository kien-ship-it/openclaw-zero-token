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
Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6IlFaZ045SHFOa0dORU00R2VLY3pEMDJQY1Z2NCIsImtpZCI6IlFaZ045SHFOa0dORU00R2VLY3pEMDJQY1Z2NCJ9.eyJhdWQiOiJhcGk6Ly9jaGF0LmFpLmpoLmVkdSIsImlzcyI6Imh0dHBzOi8vc3RzLndpbmRvd3MubmV0LzlmYTRmNDM4LWIxZTYtNDczYi04MDNmLTg2ZjhhZWRmMGRlYy8iLCJpYXQiOjE3NzM0MjIzNjgsIm5iZiI6MTc3MzQyMjM2OCwiZXhwIjoxNzczNDI2MzU2LCJhY3IiOiIxIiwiYWlvIjoiQVhRQWkvOGJBQUFBMjNwU2NZRFplSXhLeTdHa2tlRHI1N0pybE4yWnFyTGtsYSs0TFd6UEI4Kzc2R1QzalA4QjBYMmd5U1UrZklIMVhNcVYzbzIzek5CS2s2YkJKMnFUV0k4cmZpMVcvVko2V0hreGVNUlpIQ2UrVURXamlmdWZSMkl3TG9DbXF1Z2hjL080V1FYcG8wL2FMTkxEYW90WHJBPT0iLCJhbXIiOlsicHdkIl0sImFwcGlkIjoiYTVlZDg1ZjctYmNjMC00YjNiLWE5YzYtOTVhMWUzZmI2Njg1IiwiYXBwaWRhY3IiOiIxIiwiZmFtaWx5X25hbWUiOiJMZSIsImdpdmVuX25hbWUiOiJLaWVuIiwiaXBhZGRyIjoiMTI4LjIyMC4xNTkuMjEwIiwibmFtZSI6IktpZW4gTGUiLCJvaWQiOiJmZjhiODliYy0xNmMwLTRlYzAtYjAyYS1kNjNiNzQxMGJjZGMiLCJvbnByZW1fc2lkIjoiUy0xLTUtMjEtMTIxNDQ0MDMzOS00ODQ3NjM4NjktNzI1MzQ1NTQzLTU5NTc5OTQiLCJyaCI6IjEuQVFnQU9QU2tuLWF4TzBlQVA0YjRydDhON1BlRjdhWEF2RHRMcWNhVm9lUDdab1VJQUFrSUFBLiIsInNjcCI6ImFjY2Vzc191c2VyIiwic2lkIjoiMDAyZjA3MmEtOTM5OC03ZWNkLTgxNWQtMjY2NThjMjllOWVkIiwic3ViIjoiLXlkbUZhQ3FlLTl0eFRTbVZyNzZQQmNvMUR4MS1GbHhONHpNR181b1A2ayIsInRpZCI6IjlmYTRmNDM4LWIxZTYtNDczYi04MDNmLTg2ZjhhZWRmMGRlYyIsInVuaXF1ZV9uYW1lIjoiZGxlMjZAamguZWR1IiwidXBuIjoiZGxlMjZAamguZWR1IiwidXRpIjoicXd4SHlLLW1fRXl6S3JoQjcxRXpBQSIsInZlciI6IjEuMCIsInhtc19mdGQiOiJLeV9tOFVzRy1LcGZFQXZhX0FycXVoOThlbXppV3JSajNtbmdZNGxZQjRnQmRYTjNaWE4wTXkxa2MyMXoifQ.THJTidF47f11wybInDxtQiC89EfIwfni7gTxfTuYGCsCHus1FHIWTdfX8f7IosB0Tl8NfB87vBGezsvnpwBbigIUUSYtCh0lMk6tU3R1T2jOxF96MzYavLnSgaSUB5uK8kdG-mdYIO0GK2b7MUkl2xpDCasdfY2Vri8v78qkTIjgJlEhQDK6QZzV5z_VBf7mHS5MamdxNSF6Ktg3rhUgm3FvxFznskWYZzs_6Zi2bGt-kTrjnuKO2_zPBLarAh0QW7PxyXoIAu4L73GkQKofFQ0zTx2UtW-ir_lmN5gotA839VvoaLHFNz8Qx6ri1l0LPj0LVTZn9kF-KnRfXA-xBA
Cache-Control: no-cache
Connection: keep-alive
Content-Length: 973
Content-Type: application/json
Cookie: cf_clearance=4aPM8CS1T.D7pwq4OUXNy3ZtAv74CUiXNwE2b2dAUzs-1769123513-1.2.1.1-LED9vBJvrfP3lrL6.8aoeinyrlYMmJTDrlpNcBSCtWo1nnzJuumBPL1HEUMDiK0QWaxxvORUhv12P_XyqjFHwFlnzb6lHSsn6OzhNALGZsAwRJM0m8fwg04DT4VXcGnSNQEiBTXYhSu__DF1NXYCrRWQv6xlQ7oUzozyKvTt.Gtrc.EyW_wgk82X_2oAZahfJsksQ610wav9ctXqTyEquaGyZNXhT1cvOWkcxn0DKc8; connect.sid=s%3A6nzpnNcISSJFEdiHZo5BkH6KjEldNEUa.JiqEGYYfA6agrdPnxQeInLSF7fVLvkTvVqbvTPqH9TQ; token_provider=openid; refreshToken=1.AQgAOPSkn-axO0eAP4b4rt8N7PeF7aXAvDtLqcaVoeP7ZoUIAAkIAA.BQABAwEAAAADAOz_BQD0_0V2b1N0c0FydGlmYWN0cwIAAAAAAJJzAx0cjX90f5YEATvzXg0E_FsbnlLB-70gIcmQYN8qsYhpqh_Tfm54GKG-Sz5-isZv-KcciPBbyuyxOW_za_pZXsiP91XQkvzBGrmUcl7QORGdYM-78gxZmpJMMZ2C5vfqj8s4Se3BsvDDONuJCvyWHgF4sNyVfcHJwS-2RTSOKYMMrhRP_xGUyocKPYQXWqdue89NGLYXV1PkP8NcNxaa84DBRaIjU119slFlSkvB9LDX19BOTo2ouAab5cb0Zg6Os2UacAh_uLoESmBvFm1P7ItnxMOXbSEIUbkzowWEqSM-1-8uy9ns3SWJchL5xqeoteOr2zIiIZDerUna6ADX8t2OHd3yjkN0hXeD2yXOOlgxytN3Mqff9KC2Uov4eWdfLoxOrPRYdfk4_k8pUUjDoHviHQIA4uatEFvFHVifUc7ZlyLX-Iz2IKl94IlT2G5isvJUWgIVU_gD58mAxJvEsYZ5GVaW7UTSTSFFo7T6S74WtR8Vs0y3M7zOfSi_YGcvCSUzsWtZb4ZpVeyS87sZlVFCAIbN5nRzV2hACUpE8a-uT3VbEwAoBkqa64SPzPJ3tEGqbExRAh2Ksrp6mZ5CAmeokFnhIpGeoxdVbZct7IRqiv7PFn1TaH6b5kHPhWPSDawMGCHQCemYoUo_IttAv4jfvy3qX3rJuzlMDaRZpmQ9VVuIOWRpLOyGMmJsHqcIXTRDLsdPdJoOcVEwpIB7khlpJ32xi1JJ3UUUiCxP0MjYmb11Q3B3TDo0bCa56fXnagdKJaEbWPT1cqM40Q4DaEPpS9jzFRozIL_jNUqFdtCIBxLFqzNcK-QKbvxvRqf7yXlagGoQU1_a4PT3bCzalBk1BcXBjSL7wVmKw6gwd7wfUQJsMMUEYDf6Tp2j8ji1opbaBps_F4jhNHo70fbP4qTeXtOkIfOkcB3Kh7JrBNlNJUGo9uM-WjgLkO-1jPgtkUv2rFc7WoIMOxvfVxSdDjvd4v2zuQmYK4SNMC8cGJDB4w8MrKaOv8VpUAhP0PIEQ5CJV2wO8yO5zQQNOTOCNSRK6sehKYm0M_1gGX-u7gCurqNrGLPYk8aDBt-3czWGfoetyB38R05FEK5w19eJsNIJRbRO_kYJgq-osKb0UGPCwu0PoZR3mZDlxqWIW1MLHqkGfZ8k0wJsbUiIddDTNSs51OwWWGe6TPKzojtWCrt1dFmhe0YWukKJYNf7E-K3B2i8t-pa47JFWgyDxSSsWYj5Ga-yjNqzkpXKbQmZNmxbKGHAFffTtWdKHqGupowasUInmJlDRFRFDURpMI-lUO013rl_-8Y; openid_user_id=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NjJjMDZjNzhmNzMwOTAyOTY1MmY1ZiIsImlhdCI6MTc3MzQyMjY2OSwiZXhwIjoxNzc0MDI3NDY5fQ.BdwZTXSw7WuSEgcCdIBUjw3pYSF97LlBGShFEirxcFQ
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
  - Flatten the conversation history into a single string for the `text` field, or implement logic to handle stateful conversation IDs if multi-turn context must be managed on the server side.

## Phase 3: Streaming Category

**Category:** Server-Sent Events (SSE) / Custom JSON

The platform streams responses back using a standard SSE mechanism but with a custom JSON structure for the events.

- **Content-Type:** `text/event-stream`
- **Event Types:** Look for `"event":"on_message_delta"`.
- **Chunk Structure:** The actual text delta is nested within the JSON payload of the event:

  ```json
  {
    "event": "on_message_delta",
    "data": {
      "id": "step_7Im-LFL9Dzm_fAPvXzcR5",
      "delta": { "content": [{ "type": "text", "text": "Hello" }] }
    }
  }
  ```

- **Implications for Stream Handler:** The `src/agents/jh-web-stream.ts` module must parse the SSE stream, filter for `on_message_delta` events, and extract the text from the path `chunk.data.delta.content[0].text`.
