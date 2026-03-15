// ============================================
// Cloudflare Worker: TSA Wait Times Proxy
// Proxies the official TSA MyTSA Web Service API
// Deploy: npx wrangler deploy worker/tsa-proxy.js --name tsa-proxy
// ============================================

const TSA_BASE = "https://apps.tsa.dhs.gov/MyTSAWebService";
const CACHE_TTL = 300; // 5 minutes

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  "https://codewithjaidesai.github.io",
  "http://localhost",
  "http://127.0.0.1",
];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = getCorsHeaders(request);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    const airportCode = url.searchParams.get("airport");

    if (!airportCode || !/^[A-Z]{3}$/i.test(airportCode)) {
      return new Response(
        JSON.stringify({ error: "Invalid airport code. Use 3-letter IATA code (e.g., LAX)." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const code = airportCode.toUpperCase();

    // Check Cloudflare cache
    const cacheKey = new Request(`https://tsa-cache/${code}`, request);
    const cache = caches.default;
    let cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      Object.entries(corsHeaders).forEach(([k, v]) => resp.headers.set(k, v));
      return resp;
    }

    try {
      // Fetch from official TSA MyTSA API
      const tsaUrl = `${TSA_BASE}/GetTSOWaitTimes.ashx?ap=${code}&output=json`;
      const tsaResponse = await fetch(tsaUrl, {
        headers: { "User-Agent": "AirQ-TSA-Proxy/1.0" },
        cf: { cacheTtl: CACHE_TTL },
      });

      if (!tsaResponse.ok) {
        // Try the confirmed wait times endpoint as fallback
        const fallbackUrl = `${TSA_BASE}/GetConfirmedWaitTimes.ashx?ap=${code}&output=json`;
        const fallbackResponse = await fetch(fallbackUrl, {
          headers: { "User-Agent": "AirQ-TSA-Proxy/1.0" },
          cf: { cacheTtl: CACHE_TTL },
        });

        if (!fallbackResponse.ok) {
          return new Response(
            JSON.stringify({ error: "TSA API unavailable", status: fallbackResponse.status }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const data = await fallbackResponse.text();
        return buildResponse(data, code, corsHeaders, cache, cacheKey, ctx);
      }

      const data = await tsaResponse.text();
      return buildResponse(data, code, corsHeaders, cache, cacheKey, ctx);

    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Failed to reach TSA API", details: err.message }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  },
};

function buildResponse(rawData, airportCode, corsHeaders, cache, cacheKey, ctx) {
  // Try to parse as JSON, normalize the response
  let parsed;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    // If not JSON, wrap the raw text
    parsed = { raw: rawData, airport: airportCode };
  }

  const response = new Response(
    JSON.stringify({
      airport: airportCode,
      timestamp: new Date().toISOString(),
      source: "TSA MyTSA Web Service (apps.tsa.dhs.gov)",
      data: parsed,
    }),
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_TTL}`,
      },
    }
  );

  // Store in Cloudflare edge cache
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}
