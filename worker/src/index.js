/**
 * Sprint Board — Atlassian token exchange.
 *
 * WHY THIS EXISTS: Atlassian's OAuth 2.0 (3LO) token endpoint REQUIRES
 * `client_secret`; the identity server advertises only `client_secret_basic`
 * and `client_secret_post` under `token_endpoint_auth_methods_supported` —
 * there is no `none`. PKCE is supported, but ALONGSIDE the secret, not INSTEAD
 * of it. (Measured: a request without the secret returns 401 access_denied.)
 *
 * The secret cannot live inside a distributed .app — anyone who downloads the
 * zip can read it. This Worker's only job is to add the secret and forward the
 * request to Atlassian.
 *
 * NOTHING IS STORED OR LOGGED. Tokens exist only for the duration of the
 * request; the Worker keeps no state.
 */

const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Forward to Atlassian and return the response as-is. Never log the body. */
async function forward(payload) {
  const r = await fetch(ATLASSIAN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "sprint-board-auth" });
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const common = {
      client_id: env.ATLASSIAN_CLIENT_ID,
      client_secret: env.ATLASSIAN_CLIENT_SECRET,
    };

    // --- first sign-in: authorization code -> token ---
    if (url.pathname === "/token") {
      const { code, code_verifier, redirect_uri } = body;
      if (!code || !code_verifier || !redirect_uri) {
        return json({ error: "missing_parameters" }, 400);
      }
      // Only the app's own local callback. Letting a public endpoint be used
      // with an arbitrary redirect_uri would make this Worker usable for
      // somebody else's OAuth flow.
      const ok = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback$/.test(redirect_uri);
      if (!ok) return json({ error: "redirect_uri_not_allowed" }, 400);

      return forward({ ...common, grant_type: "authorization_code", code, code_verifier, redirect_uri });
    }

    // --- refresh: refresh token -> a new token pair ---
    if (url.pathname === "/refresh") {
      const { refresh_token } = body;
      if (!refresh_token) return json({ error: "missing_refresh_token" }, 400);
      return forward({ ...common, grant_type: "refresh_token", refresh_token });
    }

    return json({ error: "not_found" }, 404);
  },
};
