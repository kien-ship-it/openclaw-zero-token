import { chromium } from "playwright-core";
import { getHeadersWithAuth } from "../browser/cdp.helpers.js";
import {
  launchOpenClawChrome,
  stopOpenClawChrome,
  getChromeWebSocketUrl,
} from "../browser/chrome.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import { loadConfig } from "../config/io.js";

export interface JhWebAuth {
  bearerToken: string;
  cookie: string;
  userAgent: string;
}

/**
 * Decode a JWT payload and return the `exp` field as a Unix timestamp (seconds).
 * Returns 0 if the token is malformed or missing `exp`.
 */
export function getTokenExpiresAt(bearerToken: string): number {
  try {
    const parts = bearerToken.split(".");
    if (parts.length < 2) {
      return 0;
    }
    // Base64url → base64 → decode
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8")) as Record<
      string,
      unknown
    >;
    if (typeof decoded.exp === "number") {
      return decoded.exp;
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function loginJhWeb(params: {
  onProgress: (msg: string) => void;
  openUrl?: (url: string) => Promise<boolean>;
}): Promise<JhWebAuth> {
  const rootConfig = loadConfig();
  const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
  const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
  if (!profile) {
    throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
  }

  let running: Awaited<ReturnType<typeof launchOpenClawChrome>> | { cdpPort: number };
  let didLaunch = false;

  if (browserConfig.attachOnly) {
    params.onProgress("Connecting to existing Chrome (attach mode)...");
    const wsUrl = await getChromeWebSocketUrl(profile.cdpUrl, 5000);
    if (!wsUrl) {
      throw new Error(
        `Failed to connect to Chrome at ${profile.cdpUrl}. ` +
          "Make sure Chrome is running in debug mode (./start-chrome-debug.sh)",
      );
    }
    running = { cdpPort: profile.cdpPort };
  } else {
    params.onProgress("Launching browser...");
    running = await launchOpenClawChrome(browserConfig, profile);
    didLaunch = true;
  }

  try {
    const cdpUrl = browserConfig.attachOnly
      ? profile.cdpUrl
      : `http://127.0.0.1:${running.cdpPort}`;
    let wsUrl: string | null = null;

    params.onProgress("Waiting for browser debugger...");
    for (let i = 0; i < 10; i++) {
      wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
      if (wsUrl) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!wsUrl) {
      throw new Error(`Failed to resolve Chrome WebSocket URL from ${cdpUrl} after retries.`);
    }

    params.onProgress("Connecting to browser...");
    const browser = await chromium.connectOverCDP(wsUrl, {
      headers: getHeadersWithAuth(wsUrl),
    });
    const context = browser.contexts()[0];

    // Find existing JH Chat page or create a new one
    const existingPages = context.pages();
    let page = existingPages.find((p) => p.url().includes("chat.ai.jh.edu"));

    if (page) {
      params.onProgress("Found existing JH Chat page, switching to it...");
      await page.bringToFront();
    } else {
      page = existingPages[0] || (await context.newPage());
      params.onProgress("Opening JH Chat page...");
      await page.goto("https://chat.ai.jh.edu");
    }

    const userAgent = await page.evaluate(() => navigator.userAgent);

    // Check for existing session via cookies
    params.onProgress("Checking for existing JH Chat session...");
    const existingCookies = await context.cookies(["https://chat.ai.jh.edu"]);
    const existingCookieStr = existingCookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const hasConnectSid = existingCookieStr.includes("connect.sid=");
    const hasTokenProvider = existingCookieStr.includes("token_provider=");
    const hasValidCookies =
      (hasConnectSid || hasTokenProvider || existingCookies.length > 2) &&
      existingCookieStr.length > 10;

    params.onProgress(
      hasValidCookies
        ? "Session detected. Waiting for an authenticated request to capture Bearer token..."
        : "Please log in to JH Chat in the opened browser window...",
    );

    // If already on the site, reload to trigger authenticated API requests
    if (hasValidCookies && page.url().includes("chat.ai.jh.edu")) {
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 });
      } catch {
        // Ignore reload errors
      }
    }

    return await new Promise<JhWebAuth>((resolve, reject) => {
      let capturedBearer: string | undefined;
      let resolved = false;
      let checkInterval: ReturnType<typeof setInterval> | undefined;

      const timeout = setTimeout(() => {
        if (!resolved) {
          if (checkInterval) {
            clearInterval(checkInterval);
          }
          reject(new Error("Login timed out (5 minutes)."));
        }
      }, 300000);

      const tryResolve = async () => {
        if (!capturedBearer || resolved) {
          return;
        }

        try {
          const cookies = await context.cookies(["https://chat.ai.jh.edu"]);
          if (cookies.length === 0) {
            return;
          }

          const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

          const hasSid = cookieStr.includes("connect.sid=");
          const hasTp = cookieStr.includes("token_provider=");

          if (hasSid || hasTp || cookies.length > 2) {
            resolved = true;
            clearTimeout(timeout);
            if (checkInterval) {
              clearInterval(checkInterval);
            }
            console.log(
              `[JH Web] Credentials captured (connect.sid: ${hasSid}, token_provider: ${hasTp})`,
            );
            resolve({ bearerToken: capturedBearer, cookie: cookieStr, userAgent });
          }
        } catch (e: unknown) {
          console.error(`[JH Web] Failed to fetch cookies: ${String(e)}`);
        }
      };

      // Intercept ANY request to chat.ai.jh.edu carrying a Bearer token
      page.on(
        "request",
        async (request: { url: () => string; headers: () => Record<string, string> }) => {
          if (resolved) {
            return;
          }
          const url = request.url();
          if (!url.includes("chat.ai.jh.edu")) {
            return;
          }

          const headers = request.headers();
          const authorization = headers["authorization"] ?? headers["Authorization"] ?? "";

          if (authorization.startsWith("Bearer ")) {
            const token = authorization.slice("Bearer ".length).trim();
            if (token && !capturedBearer) {
              console.log(`[JH Web] Captured Bearer token from request to ${url}`);
              capturedBearer = token;
            }
            await tryResolve();
          }
        },
      );

      page.on("close", () => {
        if (checkInterval) {
          clearInterval(checkInterval);
        }
        if (!resolved) {
          reject(new Error("Browser window closed before login was captured."));
        }
      });

      // Periodic cookie polling (catches sessions where Bearer was already captured)
      checkInterval = setInterval(tryResolve, 2000);
    });
  } finally {
    if (didLaunch && running && "proc" in running) {
      await stopOpenClawChrome(running);
    }
  }
}
