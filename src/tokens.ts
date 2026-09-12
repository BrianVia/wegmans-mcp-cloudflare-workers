import { DurableObject } from "cloudflare:workers";
import { env, type Env } from "./env.js";

const B2C_TENANT = "wegmansonline.onmicrosoft.com";
const B2C_POLICY = "B2C_1A_WegmansSignupSigninWithPhoneVerification";
const CLIENT_ID = "38c78f8d-d124-4796-8430-1cd476d9a982";
const REDIRECT_URI = "https://www.wegmans.com";

const SCOPES = [
  `https://${B2C_TENANT}/api.digitaldevelopment.wegmans.cloud/Users.Profile.Read`,
  `https://${B2C_TENANT}/api.digitaldevelopment.wegmans.cloud/Users.Profile.Write`,
  `https://${B2C_TENANT}/api.digitaldevelopment.wegmans.cloud/Google.AddressValidation`,
  `https://${B2C_TENANT}/api.digitaldevelopment.wegmans.cloud/InstacartConnect.Fulfillment`,
  `https://${B2C_TENANT}/api.digitaldevelopment.wegmans.cloud/DigitalCoupons.Offers`,
  `https://${B2C_TENANT}/api.digitaldevelopment.wegmans.cloud/Commerce.SignalR`,
  `https://${B2C_TENANT}/api.digitaldevelopment.wegmans.cloud/InstacartConnect.PostCheckout`,
  `https://${B2C_TENANT}/api.digitaldevelopment.wegmans.cloud/InstacartConnect.Feedback`,
  `https://${B2C_TENANT}/api.digitaldevelopment.wegmans.cloud/Feedback.Write`,
  "openid",
  "profile",
  "offline_access",
].join(" ");

const AUTHORIZE_BASE = `https://myaccount.wegmans.com/${B2C_TENANT}/${B2C_POLICY.toLowerCase()}/oauth2/v2.0/authorize`;
const SELF_ASSERTED_BASE = `https://myaccount.wegmans.com/${B2C_TENANT}/${B2C_POLICY}/SelfAsserted`;
const CONFIRMED_BASE = `https://myaccount.wegmans.com/${B2C_TENANT}/${B2C_POLICY}/api/CombinedSigninAndSignup/confirmed`;
const TOKEN_BASE = `https://myaccount.wegmans.com/${B2C_TENANT}/${B2C_POLICY.toLowerCase()}/oauth2/v2.0/token`;

function base64url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

const generateUUID = () => crypto.randomUUID();

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

interface StoredTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

export class WegmansAuth extends DurableObject<Env> {
  private inflight?: Promise<string>;

  async getAccessToken(): Promise<string> {
    const tokens = await this.ctx.storage.get<StoredTokens>("tokens");
    if (tokens && Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;
    if (!this.inflight) {
      this.inflight = this.resolveAccessToken(tokens).finally(() => { this.inflight = undefined; });
    }
    return this.inflight;
  }

  async status(): Promise<{ authorized: boolean; expiresAt: number | null }> {
    const tokens = await this.ctx.storage.get<StoredTokens>("tokens");
    return { authorized: !!tokens, expiresAt: tokens?.expiresAt ?? null };
  }

  private async resolveAccessToken(tokens?: StoredTokens): Promise<string> {
    if (tokens?.refreshToken) {
      try {
        const refreshed = await this.refreshAccessToken(tokens.refreshToken);
        await this.storeTokens(refreshed, tokens.refreshToken);
        return refreshed.access_token;
      } catch {
        // Expired or revoked refresh token: retry through the full login flow.
      }
    }
    if (!this.env.WEGMANS_EMAIL || !this.env.WEGMANS_PASSWORD) {
      throw new Error("Missing WEGMANS_EMAIL or WEGMANS_PASSWORD credentials (required for login)");
    }
    const authenticated = await this.authenticate(this.env.WEGMANS_EMAIL, this.env.WEGMANS_PASSWORD);
    await this.storeTokens(authenticated);
    return authenticated.access_token;
  }

  private async storeTokens(token: TokenResponse, previousRefreshToken?: string): Promise<void> {
    await this.ctx.storage.put<StoredTokens>("tokens", {
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      refreshToken: token.refresh_token ?? previousRefreshToken,
    });
  }

  private async refreshAccessToken(
  refreshToken: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPES,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    client_info: "1",
  });

  const res = await fetch(TOKEN_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

  private async authenticate(
  email: string,
  password: string
): Promise<TokenResponse> {
  const pkce = await generatePKCE();
  const state = base64url(JSON.stringify({ id: generateUUID(), meta: { interactionType: "redirect" } }));
  const nonce = generateUUID();
  const clientRequestId = generateUUID();

  // Step 1: GET the authorize page to get CSRF token and tx state
  const authorizeUrl = new URL(AUTHORIZE_BASE);
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("client-request-id", clientRequestId);
  authorizeUrl.searchParams.set("response_mode", "fragment");
  authorizeUrl.searchParams.set("client_info", "1");
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("x-client-SKU", "msal.js.browser");
  authorizeUrl.searchParams.set("x-client-VER", "4.23.0");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authPageRes = await fetch(authorizeUrl.toString(), {
    redirect: "manual",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  const authPageHtml = await authPageRes.text();
  const cookies = extractCookies(authPageRes);

  // Extract CSRF token and tx from the page
  const csrfMatch = authPageHtml.match(/"csrf"\s*:\s*"([^"]+)"/);
  const transIdMatch = authPageHtml.match(/"transId"\s*:\s*"([^"]+)"/);

  if (!csrfMatch || !transIdMatch) {
    throw new Error(
      "Failed to extract CSRF token or transaction ID from auth page"
    );
  }

  const csrf = csrfMatch[1]!;
  const transId = transIdMatch[1]!;

  // Step 2: POST credentials to SelfAsserted
  const selfAssertedUrl = `${SELF_ASSERTED_BASE}?tx=${transId}&p=${B2C_POLICY}`;
  const selfAssertedBody = new URLSearchParams({
    request_type: "RESPONSE",
    signInName: email,
    password: password,
  });

  const selfAssertedRes = await fetch(selfAssertedUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-csrf-token": csrf,
      "x-requested-with": "XMLHttpRequest",
      cookie: cookies,
      origin: `https://myaccount.wegmans.com`,
      referer: authorizeUrl.toString(),
    },
    body: selfAssertedBody.toString(),
    redirect: "manual",
  });

  if (selfAssertedRes.status !== 200) {
    const text = await selfAssertedRes.text();
    throw new Error(`Login failed (${selfAssertedRes.status}): ${text}`);
  }

  // Merge any new cookies
  const allCookies = mergeCookies(cookies, extractCookies(selfAssertedRes));

  // Step 3: GET the confirmed endpoint to get auth code
  const confirmedUrl = `${CONFIRMED_BASE}?rememberMe=true&csrf_token=${encodeURIComponent(csrf)}&tx=${transId}&p=${B2C_POLICY}`;

  const confirmedRes = await fetch(confirmedUrl, {
    headers: {
      cookie: allCookies,
      "x-requested-with": "XMLHttpRequest",
      referer: authorizeUrl.toString(),
    },
    redirect: "manual",
  });

  // The response should be a 200 with JSON containing the redirect URL, or a 302 redirect
  let authCode: string | undefined;

  if (confirmedRes.status === 302) {
    const location = confirmedRes.headers.get("location") ?? "";
    authCode = extractCodeFromUrl(location);
  } else {
    const body = await confirmedRes.text();
    // Look for redirect URL in the response
    const redirectMatch = body.match(/code=([^&"]+)/);
    if (redirectMatch) {
      authCode = redirectMatch[1];
    }
    // Also check if the response is JSON with a redirect
    try {
      const json = JSON.parse(body);
      if (json.redirectUrl) {
        authCode = extractCodeFromUrl(json.redirectUrl);
      }
    } catch {
      // Not JSON, that's fine
    }
  }

  if (!authCode) {
    throw new Error(
      `Failed to get auth code from confirmed endpoint (status: ${confirmedRes.status})`
    );
  }

  // Step 4: Exchange auth code for tokens
  const tokenBody = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code: authCode,
    code_verifier: pkce.verifier,
    grant_type: "authorization_code",
    client_info: "1",
  });

  const tokenRes = await fetch(TOKEN_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: tokenBody.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
  }

  return (await tokenRes.json()) as TokenResponse;
}

}

function extractCookies(res: Response): string {
  const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
  return setCookieHeaders
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function mergeCookies(existing: string, newCookies: string): string {
  if (!newCookies) return existing;
  if (!existing) return newCookies;
  return `${existing}; ${newCookies}`;
}

function extractCodeFromUrl(url: string): string | undefined {
  // Code can be in query params or fragment
  const codeMatch = url.match(/[?&#]code=([^&]+)/);
  return codeMatch?.[1];
}


export const getAccessToken = () => env().WEGMANS_AUTH.getByName("owner").getAccessToken();
