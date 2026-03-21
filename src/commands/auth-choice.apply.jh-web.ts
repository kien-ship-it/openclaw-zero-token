import { loginJhWeb } from "../providers/jh-web-auth.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyJhWebConfig } from "./onboard-auth.config-core.js";
import { setJhWebCredentials } from "./onboard-auth.credentials.js";

export async function applyAuthChoiceJhWeb(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "jh-web") {
    return null;
  }

  const { prompter, runtime, config, agentDir } = params;

  let bearerToken = "";
  let cookie = "";
  let userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

  const mode = await prompter.select({
    message: "JH Web Auth Mode",
    options: [
      {
        value: "attach",
        label: "Attach to Existing Browser (Recommended)",
        hint: "Use already-debugged Chrome, opens chat.ai.jh.edu if needed",
      },
      {
        value: "manual",
        label: "Manual Paste",
        hint: "Paste Cookie and Bearer headers manually",
      },
    ],
  });

  if (mode === "attach") {
    const spin = prompter.progress("Connecting to existing Chrome...");
    try {
      const result = await loginJhWeb({
        onProgress: (msg) => spin.update(msg),
      });
      spin.stop("Login captured successfully!");
      bearerToken = result.bearerToken;
      cookie = result.cookie;
      userAgent = result.userAgent;
      await setJhWebCredentials({ bearerToken, cookie, userAgent }, agentDir);
    } catch (err) {
      spin.stop("Attach login failed.");
      runtime.error(String(err));
      const retryManual = await prompter.confirm({
        message: "Would you like to try manual paste instead?",
        initialValue: true,
      });
      if (!retryManual) {
        throw err;
      }
      // Fall through to manual
    }
  }

  if (!bearerToken || !cookie) {
    await prompter.note(
      [
        "To use JH Web manually, you need credentials from chat.ai.jh.edu.",
        "1. Login to https://chat.ai.jh.edu in your browser",
        "2. Open DevTools (F12) -> Network tab",
        "3. Send a chat message to trigger a request to /api/agents/chat/*",
        "4. Click that request and copy the 'Cookie' and 'Authorization' headers.",
      ].join("\n"),
      "JH Web Login",
    );

    const rawInput = await prompter.text({
      message:
        "Paste Cookie / Authorization headers (e.g. 'Cookie: ...' and 'Authorization: Bearer ...')",
      placeholder: "cf_clearance=...; connect.sid=...",
      validate: (value) => (value.trim().length > 0 ? undefined : "Required"),
    });

    const lines = rawInput.split("\n");
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.startsWith("cookie:")) {
        cookie = line.slice(7).trim();
      } else if (lower.startsWith("authorization:")) {
        const val = line.slice(14).trim();
        if (val.toLowerCase().startsWith("bearer ")) {
          bearerToken = val.slice(7).trim();
        }
      } else if (line.includes("=") && line.includes(";") && !cookie) {
        cookie = line.trim();
      }
    }

    if (!cookie) {
      cookie = rawInput.trim();
    }

    if (!bearerToken) {
      const bearerMatch = rawInput.match(/bearer\s+([a-zA-Z0-9.\-_/]+)/i);
      if (bearerMatch) {
        bearerToken = bearerMatch[1];
      }
    }

    if (!bearerToken) {
      bearerToken = await prompter.text({
        message: "Authorization Bearer token (Optional — paste Bearer value if available)",
        placeholder: "Optional",
      });
    }

    await setJhWebCredentials({ bearerToken: bearerToken.trim(), cookie, userAgent }, agentDir);
  }

  const nextConfig = applyJhWebConfig(config);

  return { config: nextConfig };
}
