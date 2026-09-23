/**
 * Sprint Board — Atlassian token değişimi.
 *
 * NEDEN VAR: Atlassian OAuth 2.0 (3LO) token uç noktası `client_secret`
 * ZORUNLU tutuyor; kimlik sunucusu `token_endpoint_auth_methods_supported`
 * olarak yalnızca `client_secret_basic` ve `client_secret_post` ilan ediyor,
 * `none` yok. Yani PKCE destekleniyor ama secret'ın YERİNE değil YANINDA.
 * (Ölçüldü: secret'sız istek 401 access_denied döner.)
 *
 * Secret dağıtılan bir .app'in içine konamaz — zip'i indiren herkes okur.
 * Bu Worker'ın tek işi secret'ı ekleyip isteği Atlassian'a iletmek.
 *
 * HİÇBİR ŞEY SAKLANMAZ VE LOGLANMAZ. Token'lar yalnızca bu istek boyunca
 * bellekte durur; Worker durum tutmaz.
 */

const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Atlassian'a ilet, cevabı olduğu gibi döndür. Gövdeyi asla loglama. */
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

    // --- ilk giriş: authorization code -> token ---
    if (url.pathname === "/token") {
      const { code, code_verifier, redirect_uri } = body;
      if (!code || !code_verifier || !redirect_uri) {
        return json({ error: "missing_parameters" }, 400);
      }
      // Yalnızca uygulamanın kendi yerel callback'i. Açık bir uç noktayı
      // rastgele bir redirect_uri ile kullandırmak, bu Worker'ı başkasının
      // OAuth akışı için kullanılabilir hale getirirdi.
      const ok = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback$/.test(redirect_uri);
      if (!ok) return json({ error: "redirect_uri_not_allowed" }, 400);

      return forward({ ...common, grant_type: "authorization_code", code, code_verifier, redirect_uri });
    }

    // --- yenileme: refresh token -> yeni token çifti ---
    if (url.pathname === "/refresh") {
      const { refresh_token } = body;
      if (!refresh_token) return json({ error: "missing_refresh_token" }, 400);
      return forward({ ...common, grant_type: "refresh_token", refresh_token });
    }

    return json({ error: "not_found" }, 404);
  },
};
