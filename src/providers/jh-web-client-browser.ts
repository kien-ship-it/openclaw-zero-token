import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { getHeadersWithAuth } from "../browser/cdp.helpers.js";
import {
  launchOpenClawChrome,
  stopOpenClawChrome,
  getChromeWebSocketUrl,
  type RunningChrome,
} from "../browser/chrome.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import { loadConfig } from "../config/io.js";
import { getTokenExpiresAt, loginJhWeb, type JhWebAuth } from "./jh-web-auth.js";

export interface JhWebClientOptions {
  bearerToken: string;
  cookie: string;
  userAgent: string;
  model?: string;
}

/** Maps model IDs to chat.ai.jh.edu endpoint path segments. */
const MODEL_ENDPOINT_MAP: Record<string, string> = {
  "claude-opus-4.5": "AnthropicClaude",
  "claude-sonnet-4.5": "AnthropicClaude",
  "claude-haiku-4.5": "AnthropicClaude",
  AnthropicClaude: "AnthropicClaude",
  // Additional known endpoints – extend as the platform adds models
  "gpt-4o": "OpenAI",
  "gpt-4o-mini": "OpenAI",
  OpenAI: "OpenAI",
  "gemini-2.0-flash": "Google",
  "gemini-1.5-pro": "Google",
  Google: "Google",
};

const DEFAULT_ENDPOINT = "AnthropicClaude";
const BASE_URL = "https://chat.ai.jh.edu";

/** Null UUID used as parentMessageId for the first message in a conversation. */
const NULL_UUID = "00000000-0000-0000-0000-000000000000";

/** Default greeting injected by the HopGPT platform. */
const JH_DEFAULT_GREETING =
  "Use HopGPT as a supportive tool that you complement with your own expertise, " +
  "critical thinking, professional judgment, and additional research. Please note that " +
  "all chats are automatically **purged after 30 days** per our " +
  "[data retention](https://hopgpt.it.jh.edu/data-retention-notice/) policy. " +
  "Use of HopGPT must comply with the [Terms of Use](https://hopgpt.it.jh.edu/terms/).\n";

/** Five minutes in seconds. */
const EXPIRY_WARN_THRESHOLD_S = 5 * 60;

interface SessionState {
  conversationId: string;
  lastParentMessageId: string;
}

function resolveEndpoint(model?: string): string {
  if (!model) {
    return DEFAULT_ENDPOINT;
  }
  return MODEL_ENDPOINT_MAP[model] ?? DEFAULT_ENDPOINT;
}

function formatClientTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * JH Chat browser-based API client.
 * Uses Playwright CDP to run requests inside a live browser page, bypassing
 * Cloudflare TLS fingerprint checks.
 */
export class JhWebClientBrowser {
  private bearerToken: string;
  private cookie: string;
  private userAgent: string;
  private defaultModel: string;
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private running: RunningChrome | null = null;
  /** Keyed by `${conversationId}` or a caller-supplied session key. */
  private sessionState = new Map<string, SessionState>();
  /** Whether a token re-auth is currently in progress (prevents re-entrant retries). */
  private reAuthInProgress = false;

  constructor(options: JhWebClientOptions | string) {
    if (typeof options === "string") {
      const parsed = JSON.parse(options) as JhWebClientOptions;
      this.bearerToken = parsed.bearerToken;
      this.cookie = parsed.cookie;
      this.userAgent = parsed.userAgent || "Mozilla/5.0";
      this.defaultModel = parsed.model ?? "claude-opus-4.5";
    } else {
      this.bearerToken = options.bearerToken;
      this.cookie = options.cookie;
      this.userAgent = options.userAgent || "Mozilla/5.0";
      this.defaultModel = options.model ?? "claude-opus-4.5";
    }
  }

  private checkTokenExpiry(): void {
    const exp = getTokenExpiresAt(this.bearerToken);
    if (exp === 0) {
      return;
    }
    const nowS = Math.floor(Date.now() / 1000);
    const secsLeft = exp - nowS;
    if (secsLeft <= 0) {
      throw new Error(
        "[JH Web] Bearer token has expired. Please re-run onboarding to capture a fresh token.",
      );
    }
    if (secsLeft <= EXPIRY_WARN_THRESHOLD_S) {
      console.warn(
        `[JH Web] Bearer token expires in ${secsLeft}s (<5 min). Consider re-authenticating soon.`,
      );
    }
  }

  private async ensureBrowser(): Promise<{ browser: BrowserContext; page: Page }> {
    if (this.browser && this.page) {
      return { browser: this.browser, page: this.page };
    }

    const rootConfig = loadConfig();
    const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
    const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
    if (!profile) {
      throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
    }

    if (browserConfig.attachOnly) {
      console.log(`[JH Web Browser] Connecting to existing Chrome at ${profile.cdpUrl}`);
      let wsUrl: string | null = null;
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(profile.cdpUrl, 2000);
        if (wsUrl) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(
          `Failed to connect to Chrome at ${profile.cdpUrl}. ` +
            "Make sure Chrome is running in debug mode (./start-chrome-debug.sh)",
        );
      }
      this.browser = await chromium
        .connectOverCDP(wsUrl, { headers: getHeadersWithAuth(wsUrl) })
        .then((b) => b.contexts()[0]);

      if (!this.browser) {
        throw new Error("Failed to connect to Chrome browser context");
      }

      const pages = this.browser.pages();
      const jhPage = pages.find((p) => p.url().includes("chat.ai.jh.edu"));
      if (jhPage) {
        console.log(`[JH Web Browser] Found existing JH Chat page: ${jhPage.url()}`);
        this.page = jhPage;
      } else {
        console.log("[JH Web Browser] No JH Chat page found, creating new one...");
        this.page = await this.browser.newPage();
        await this.page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      }
    } else {
      this.running = await launchOpenClawChrome(browserConfig, profile);
      const cdpUrl = `http://127.0.0.1:${this.running.cdpPort}`;
      let wsUrl: string | null = null;
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
        if (wsUrl) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(`Failed to resolve Chrome WebSocket URL from ${cdpUrl}`);
      }

      this.browser = await chromium
        .connectOverCDP(wsUrl, { headers: getHeadersWithAuth(wsUrl) })
        .then((b) => b.contexts()[0]);

      if (!this.browser) {
        throw new Error("Failed to connect to Chrome browser context");
      }
      this.page = this.browser.pages()[0] ?? (await this.browser.newPage());
    }

    // Inject cookies so the browser page is authenticated.
    const parsedCookies = this.cookie
      .split(";")
      .map((c) => {
        const [name, ...rest] = c.trim().split("=");
        const nameStr = (name ?? "").trim();
        const valueStr = rest.join("=").trim();
        if (!nameStr) {
          return null;
        }
        return {
          name: nameStr,
          value: valueStr,
          domain: "chat.ai.jh.edu",
          path: "/",
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (parsedCookies.length > 0) {
      try {
        await this.browser.addCookies(parsedCookies);
      } catch (err) {
        console.warn(
          `[JH Web Browser] addCookies warning: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!this.browser || !this.page) {
      throw new Error("Failed to initialize browser context");
    }

    return { browser: this.browser, page: this.page };
  }

  async init(): Promise<void> {
    await this.ensureBrowser();
  }

  /**
   * Attempt a re-auth by re-launching the browser login flow and refreshing
   * the stored bearer token + cookie from the live session.
   */
  private async reAuth(): Promise<void> {
    if (this.reAuthInProgress) {
      throw new Error(
        "[JH Web] Re-auth already in progress. Please wait or re-run onboarding manually.",
      );
    }
    this.reAuthInProgress = true;
    try {
      console.log("[JH Web] 401 detected – triggering automatic re-auth via browser login...");
      const fresh: JhWebAuth = await loginJhWeb({
        onProgress: (msg) => console.log(`[JH Web re-auth] ${msg}`),
      });
      this.bearerToken = fresh.bearerToken;
      this.cookie = fresh.cookie;
      this.userAgent = fresh.userAgent || this.userAgent;
      console.log("[JH Web] Re-auth complete – token refreshed.");
    } finally {
      this.reAuthInProgress = false;
    }
  }

  /**
   * Send a chat message to chat.ai.jh.edu and return the raw SSE stream.
   *
   * @param text - The user message text.
   * @param opts - Optional overrides (model, sessionKey, conversationId for server-side reuse).
   */
  async chatCompletions(params: {
    message: string;
    model?: string;
    /** Caller-supplied key to track multi-turn conversation state. */
    sessionKey?: string;
    /**
     * Optional: reuse an existing server-side conversationId.
     * When provided, the client will attach to that conversation instead of
     * starting a new one (server-side multi-turn context reuse, step 5.4).
     */
    conversationId?: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    this.checkTokenExpiry();

    const { page } = await this.ensureBrowser();

    const model = params.model ?? this.defaultModel;
    const endpoint = resolveEndpoint(model);
    const sessionKey = params.sessionKey ?? "default";

    let state = this.sessionState.get(sessionKey);
    if (!state) {
      state = {
        // Use caller-supplied conversationId (server-side reuse) or generate a new one.
        conversationId: params.conversationId ?? crypto.randomUUID(),
        lastParentMessageId: NULL_UUID,
      };
      this.sessionState.set(sessionKey, state);
    } else if (params.conversationId && params.conversationId !== state.conversationId) {
      // Caller wants to switch to a different server-side conversation.
      state = {
        conversationId: params.conversationId,
        lastParentMessageId: NULL_UUID,
      };
      this.sessionState.set(sessionKey, state);
    }

    const messageId = crypto.randomUUID();
    const clientTimestamp = formatClientTimestamp(new Date());

    const body = {
      text: params.message,
      sender: "User",
      clientTimestamp,
      isCreatedByUser: true,
      parentMessageId: state.lastParentMessageId,
      conversationId: state.conversationId,
      messageId,
      error: false,
      endpoint,
      endpointType: "custom",
      model,
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

    const url = `${BASE_URL}/api/agents/chat/${endpoint}`;
    const bearerToken = this.bearerToken;
    const cookie = this.cookie;
    const userAgent = this.userAgent;

    console.log(`[JH Web Browser] POST ${url}`);
    console.log(`[JH Web Browser] Model: ${model}, ConversationId: ${state.conversationId}`);

    const fetchTimeoutMs = 300_000;

    const responseData = await page.evaluate(
      async ({
        url: reqUrl,
        body: reqBody,
        bearerToken: token,
        cookie: cookieStr,
        userAgent: ua,
        timeoutMs,
      }) => {
        let timer: ReturnType<typeof setTimeout> | undefined = undefined;
        try {
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), timeoutMs);

          const res = await fetch(reqUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              Authorization: `Bearer ${token}`,
              Cookie: cookieStr,
              "User-Agent": ua,
              Origin: "https://chat.ai.jh.edu",
              Referer: "https://chat.ai.jh.edu/",
            },
            body: JSON.stringify(reqBody),
            signal: controller.signal,
          });

          clearTimeout(timer);

          if (!res.ok) {
            const errorText = await res.text();
            return { ok: false as const, status: res.status, error: errorText.slice(0, 500) };
          }

          const reader = res.body?.getReader();
          if (!reader) {
            return { ok: false as const, status: 500, error: "No response body" };
          }

          const decoder = new TextDecoder();
          let fullText = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            fullText += decoder.decode(value, { stream: true });
          }

          return { ok: true as const, data: fullText };
        } catch (err) {
          if (typeof timer !== "undefined") {
            clearTimeout(timer);
          }
          const msg = String(err);
          if (msg.includes("aborted") || msg.includes("signal")) {
            return {
              ok: false as const,
              status: 408,
              error: `Request timed out after ${timeoutMs}ms`,
            };
          }
          return { ok: false as const, status: 500, error: msg };
        }
      },
      { url, body, bearerToken, cookie, userAgent, timeoutMs: fetchTimeoutMs },
    );

    if (!responseData.ok) {
      console.error(
        `[JH Web Browser] Request failed: ${responseData.status} - ${responseData.error}`,
      );

      if (responseData.status === 401) {
        // Attempt automatic token refresh (step 5.1).
        if (!this.reAuthInProgress) {
          await this.reAuth();
          // Retry the request once with fresh credentials.
          return this.chatCompletions(params);
        }
        throw new Error(
          "[JH Web] Authentication failed (401) after re-auth attempt. " +
            "Please re-run onboarding manually.",
        );
      }

      if (responseData.status === 403) {
        // Distinguish Cloudflare challenge from a plain 403 (step 5.2).
        const isCloudflareChallenge =
          (responseData.error ?? "").toLowerCase().includes("cloudflare") ||
          (responseData.error ?? "").toLowerCase().includes("cf_clearance") ||
          (responseData.error ?? "").toLowerCase().includes("challenge") ||
          (responseData.error ?? "").toLowerCase().includes("just a moment");

        if (isCloudflareChallenge) {
          throw new Error(
            "[JH Web] Cloudflare bot-protection challenge detected (403). " +
              "Your cf_clearance cookie has expired or is invalid. " +
              "Open chat.ai.jh.edu in Chrome, complete the challenge, then re-run onboarding.",
          );
        }
        throw new Error(
          "[JH Web] Access forbidden (403). Your session may have expired. " +
            "Re-run onboarding to refresh your JH credentials.",
        );
      }

      if (responseData.status === 408) {
        throw new Error(
          `[JH Web] Request timed out. ${responseData.error ?? ""} ` +
            "Ensure chat.ai.jh.edu is reachable and Chrome is connected.",
        );
      }
      throw new Error(
        `[JH Web] API error ${responseData.status}: ${responseData.error ?? "Request failed"}`,
      );
    }

    // Advance conversation state: the current messageId becomes the next parentMessageId.
    state.lastParentMessageId = messageId;
    this.sessionState.set(sessionKey, state);

    console.log(`[JH Web Browser] Response length: ${responseData.data?.length ?? 0} bytes`);
    console.log(`[JH Web Browser] Preview: ${responseData.data?.slice(0, 200) ?? "empty"}`);

    // Debug: dump raw SSE response to temp file for format inspection
    try {
      const fsSync = await import("node:fs");
      fsSync.writeFileSync("/tmp/jh-web-sse-debug.txt", responseData.data ?? "", "utf8");
      console.log("[JH Web Browser] Raw SSE dump written to /tmp/jh-web-sse-debug.txt");
    } catch (e) {
      console.warn(`[JH Web Browser] Failed to write debug dump: ${String(e)}`);
    }

    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(responseData.data));
        controller.close();
      },
    });
  }

  async close(): Promise<void> {
    if (this.running) {
      await stopOpenClawChrome(this.running);
      this.running = null;
    }
    this.browser = null;
    this.page = null;
  }
}
