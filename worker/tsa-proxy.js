// ============================================
// Cloudflare Worker: TSA Wait Times Proxy + Crowd Reports (KV)
// Proxies the official TSA MyTSA Web Service API
// Stores crowd-reported wait times in Cloudflare KV for shared access
//
// Routes:
//   GET  /?airport=LAX           → TSA wait times
//   GET  /history?airport=LAX    → 24h wait time history (auto-recorded)
//   GET  /crowd?airport=LAX      → Get crowd reports for airport
//   POST /crowd                  → Submit a crowd report
//
// Deploy: cd worker && npx wrangler deploy
// ============================================

const TSA_BASE = "https://apps.tsa.dhs.gov/MyTSAWebService";
const CACHE_TTL = 300; // 5 minutes
const CROWD_REPORT_TTL = 4 * 60 * 60; // 4 hours in seconds
const MAX_REPORTS_PER_AIRPORT = 200;
const HISTORY_TTL = 24 * 60 * 60; // 24 hours in seconds
const HISTORY_MIN_INTERVAL = 2 * 60 * 1000; // 2 min between snapshots
const MAX_HISTORY_POINTS = 720; // 24h at 2-min intervals

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Top US airports to auto-fetch every 2 minutes via cron
const POPULAR_AIRPORTS = [
  "ATL", "LAX", "JFK", "ORD", "DFW", "DEN", "SFO", "SEA",
  "MIA", "LAS", "BOS", "MCO", "EWR", "CLT", "PHX", "IAH",
  "MSP", "DTW", "FLL", "BWI", "SLC", "DCA", "SAN", "IAD",
  "TPA", "AUS", "BNA", "STL", "HNL", "PDX", "OAK", "RDU",
  "MCI", "CLE", "SMF", "SJC", "IND", "PIT", "CMH", "SAT",
];

export default {
  // Cron trigger: auto-fetch TSA data for all popular airports
  async scheduled(event, env, ctx) {
    const results = [];
    // Fetch in batches of 8 to avoid overwhelming TSA API
    for (let i = 0; i < POPULAR_AIRPORTS.length; i += 8) {
      const batch = POPULAR_AIRPORTS.slice(i, i + 8);
      const promises = batch.map(async (code) => {
        try {
          const data = await fetchTSADirect(code);
          if (data) {
            await saveHistorySnapshot(code, data, env);
            results.push({ code, ok: true });
          } else {
            results.push({ code, ok: false, reason: "no data" });
          }
        } catch (err) {
          results.push({ code, ok: false, reason: err.message });
        }
      });
      await Promise.all(promises);
    }
    console.log(`Cron: fetched ${results.filter(r => r.ok).length}/${POPULAR_AIRPORTS.length} airports`);
  },

  async fetch(request, env, ctx) {
    const corsHeaders = getCorsHeaders(request);
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Route: wait time history
    if (url.pathname === "/history" && request.method === "GET") {
      return handleHistoryGet(url, env, corsHeaders);
    }

    // Route: debug — check cron status and force a snapshot
    if (url.pathname === "/debug" && request.method === "GET") {
      const code = (url.searchParams.get("airport") || "AUS").toUpperCase();
      const tsaData = await fetchTSADirect(code);
      const snapshot = tsaData ? extractWaitSnapshot(tsaData) : null;
      if (snapshot && tsaData) {
        await saveHistorySnapshot(code, tsaData, env);
      }
      const kvKey = `history:${code}`;
      const stored = await env.CROWD_KV.get(kvKey, "json") || [];
      return jsonResponse({
        airport: code,
        tsaDataReceived: !!tsaData,
        tsaDataKeys: tsaData ? Object.keys(tsaData) : null,
        tsaDataSample: tsaData ? JSON.stringify(tsaData).substring(0, 500) : null,
        snapshotExtracted: snapshot,
        historyPoints: stored.length,
        lastPoint: stored.length > 0 ? stored[stored.length - 1] : null,
      }, 200, corsHeaders);
    }

    // Route: crowd reports
    if (url.pathname === "/crowd") {
      if (request.method === "POST") {
        return handleCrowdSubmit(request, env, corsHeaders);
      }
      if (request.method === "GET") {
        return handleCrowdGet(url, env, corsHeaders);
      }
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    // Route: TSA wait times (GET only)
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    return handleTSAFetch(url, corsHeaders, request, ctx);
  },
};

// ============================================
// TSA WAIT TIMES
// ============================================

// Direct TSA fetch (used by cron, no CORS/caching overhead)
async function fetchTSADirect(code) {
  try {
    const tsaUrl = `${TSA_BASE}/GetTSOWaitTimes.ashx?ap=${code}&output=json`;
    let tsaResponse = await fetch(tsaUrl, {
      headers: { "User-Agent": "AirQ-TSA-Proxy/1.0" },
    });

    if (!tsaResponse.ok) {
      const fallbackUrl = `${TSA_BASE}/GetConfirmedWaitTimes.ashx?ap=${code}&output=json`;
      tsaResponse = await fetch(fallbackUrl, {
        headers: { "User-Agent": "AirQ-TSA-Proxy/1.0" },
      });
    }

    if (!tsaResponse.ok) return null;

    const rawData = await tsaResponse.text();
    try {
      return JSON.parse(rawData);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function handleTSAFetch(url, corsHeaders, request, ctx) {
  const airportCode = url.searchParams.get("airport");

  if (!airportCode || !/^[A-Z]{3}$/i.test(airportCode)) {
    return jsonResponse(
      { error: "Invalid airport code. Use 3-letter IATA code (e.g., LAX)." },
      400, corsHeaders
    );
  }

  const code = airportCode.toUpperCase();

  // Check Cloudflare cache
  const cacheKey = new Request(`https://tsa-cache/${code}`, request);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const resp = new Response(cached.body, cached);
    Object.entries(corsHeaders).forEach(([k, v]) => resp.headers.set(k, v));
    return resp;
  }

  try {
    // Try primary TSA endpoint
    const tsaUrl = `${TSA_BASE}/GetTSOWaitTimes.ashx?ap=${code}&output=json`;
    let tsaResponse = await fetch(tsaUrl, {
      headers: { "User-Agent": "AirQ-TSA-Proxy/1.0" },
      cf: { cacheTtl: CACHE_TTL },
    });

    // Fallback to confirmed wait times endpoint
    if (!tsaResponse.ok) {
      const fallbackUrl = `${TSA_BASE}/GetConfirmedWaitTimes.ashx?ap=${code}&output=json`;
      tsaResponse = await fetch(fallbackUrl, {
        headers: { "User-Agent": "AirQ-TSA-Proxy/1.0" },
        cf: { cacheTtl: CACHE_TTL },
      });
    }

    if (!tsaResponse.ok) {
      return jsonResponse(
        { error: "TSA API unavailable", status: tsaResponse.status },
        502, corsHeaders
      );
    }

    const rawData = await tsaResponse.text();
    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      parsed = { raw: rawData, airport: code };
    }

    const responseData = {
      airport: code,
      timestamp: new Date().toISOString(),
      source: "TSA MyTSA Web Service (apps.tsa.dhs.gov)",
      data: parsed,
    };

    // Save snapshot to history (non-blocking)
    ctx.waitUntil(saveHistorySnapshot(code, parsed, env));

    const response = jsonResponse(responseData, 200, corsHeaders);
    response.headers.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;

  } catch (err) {
    return jsonResponse(
      { error: "Failed to reach TSA API", details: err.message },
      502, corsHeaders
    );
  }
}

// ============================================
// CROWD REPORTS (Cloudflare KV)
// ============================================

// GET /crowd?airport=LAX — returns recent crowd reports
async function handleCrowdGet(url, env, corsHeaders) {
  const airportCode = url.searchParams.get("airport");
  if (!airportCode || !/^[A-Z]{3}$/i.test(airportCode)) {
    return jsonResponse({ error: "Invalid airport code" }, 400, corsHeaders);
  }

  const code = airportCode.toUpperCase();
  const kvKey = `crowd:${code}`;

  try {
    const stored = await env.CROWD_KV.get(kvKey, "json");
    const reports = stored || [];

    // Filter to last 4 hours
    const cutoff = Date.now() - CROWD_REPORT_TTL * 1000;
    const recent = reports.filter(r => r.timestamp > cutoff);

    return jsonResponse({
      airport: code,
      reports: recent,
      count: recent.length,
    }, 200, corsHeaders);
  } catch (err) {
    return jsonResponse({ error: "Failed to read reports", details: err.message }, 500, corsHeaders);
  }
}

// POST /crowd — submit a new crowd report
async function handleCrowdSubmit(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const { airportCode, terminal, type, waitMinutes } = body;

  // Validate
  if (!airportCode || !/^[A-Z]{3}$/i.test(airportCode)) {
    return jsonResponse({ error: "Invalid airport code" }, 400, corsHeaders);
  }
  if (typeof waitMinutes !== "number" || waitMinutes < 0 || waitMinutes > 180) {
    return jsonResponse({ error: "waitMinutes must be 0-180" }, 400, corsHeaders);
  }
  if (!type || !["standard", "precheck"].includes(type)) {
    return jsonResponse({ error: "type must be 'standard' or 'precheck'" }, 400, corsHeaders);
  }

  const code = airportCode.toUpperCase();
  const kvKey = `crowd:${code}`;

  const report = {
    terminal: terminal || "Main",
    type,
    waitMinutes: Math.round(waitMinutes),
    timestamp: Date.now(),
    id: crypto.randomUUID(),
  };

  try {
    // Read existing reports
    const stored = await env.CROWD_KV.get(kvKey, "json") || [];

    // Remove expired reports (older than 4 hours)
    const cutoff = Date.now() - CROWD_REPORT_TTL * 1000;
    const active = stored.filter(r => r.timestamp > cutoff);

    // Add new report
    active.push(report);

    // Cap at MAX_REPORTS_PER_AIRPORT
    const trimmed = active.slice(-MAX_REPORTS_PER_AIRPORT);

    // Write back with expiration (auto-cleanup after 24 hours of no writes)
    await env.CROWD_KV.put(kvKey, JSON.stringify(trimmed), {
      expirationTtl: 24 * 60 * 60,
    });

    return jsonResponse({
      success: true,
      report,
      totalReports: trimmed.length,
    }, 201, corsHeaders);

  } catch (err) {
    return jsonResponse({ error: "Failed to save report", details: err.message }, 500, corsHeaders);
  }
}

// ============================================
// WAIT TIME HISTORY (Cloudflare KV)
// Auto-saved on every TSA fetch, served to all users
// ============================================

// Parse TSA response and extract average wait times for a snapshot
function extractWaitSnapshot(tsaData) {
  if (!tsaData) return null;

  // Handle various TSA response formats
  let records;
  if (Array.isArray(tsaData)) {
    records = tsaData;
  } else if (tsaData.WaitTimes) {
    records = Array.isArray(tsaData.WaitTimes) ? tsaData.WaitTimes : [tsaData.WaitTimes];
  } else if (tsaData.waitTimes) {
    records = Array.isArray(tsaData.waitTimes) ? tsaData.waitTimes : [tsaData.waitTimes];
  } else if (tsaData.data) {
    // Wrapped format from our own proxy
    return extractWaitSnapshot(tsaData.data);
  } else if (tsaData.WaitTime || tsaData.wait_time || tsaData.CheckpointName) {
    records = [tsaData];
  } else {
    // Try all values of object as potential records
    const vals = Object.values(tsaData);
    if (vals.length > 0 && typeof vals[0] === "object") {
      records = vals;
    } else {
      return null;
    }
  }

  if (!records || records.length === 0) return null;

  let totalStd = 0, countStd = 0, totalPc = 0, countPc = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const waitMin = parseInt(
      record.WaitTime || record.wait_time || record.estimated_wait ||
      record.mins || record.waittime || record.minutes || 0
    );
    if (isNaN(waitMin)) continue;

    const checkpoint = record.CheckpointName || record.checkpoint || record.CheckPoint || "";
    const isPrecheck = (record.PreCheck === "true" || record.precheck === true ||
      (typeof checkpoint === "string" && checkpoint.toLowerCase().includes("precheck")));

    if (isPrecheck) {
      totalPc += waitMin;
      countPc++;
    } else {
      totalStd += waitMin;
      countStd++;
    }
  }

  if (countStd === 0 && countPc === 0) return null;

  return {
    std: countStd > 0 ? Math.round(totalStd / countStd) : 0,
    pc: countPc > 0 ? Math.round(totalPc / countPc) : (countStd > 0 ? Math.max(1, Math.round((totalStd / countStd) * 0.35)) : 0),
  };
}

async function saveHistorySnapshot(airportCode, tsaData, env) {
  try {
    const snapshot = extractWaitSnapshot(tsaData);
    if (!snapshot) return;

    const kvKey = `history:${airportCode}`;
    const stored = await env.CROWD_KV.get(kvKey, "json") || [];

    // Don't save if last snapshot is too recent
    if (stored.length > 0 && Date.now() - stored[stored.length - 1].t < HISTORY_MIN_INTERVAL) return;

    const cutoff = Date.now() - HISTORY_TTL * 1000;
    const active = stored.filter(p => p.t > cutoff);

    active.push({ t: Date.now(), std: snapshot.std, pc: snapshot.pc });

    // Cap at max points
    const trimmed = active.slice(-MAX_HISTORY_POINTS);

    await env.CROWD_KV.put(kvKey, JSON.stringify(trimmed), {
      expirationTtl: HISTORY_TTL + 3600, // extra hour buffer
    });
  } catch {
    // Non-critical, fail silently
  }
}

// GET /history?airport=LAX — returns 24h wait time history
async function handleHistoryGet(url, env, corsHeaders) {
  const airportCode = url.searchParams.get("airport");
  if (!airportCode || !/^[A-Z]{3}$/i.test(airportCode)) {
    return jsonResponse({ error: "Invalid airport code" }, 400, corsHeaders);
  }

  const code = airportCode.toUpperCase();
  const kvKey = `history:${code}`;

  try {
    const stored = await env.CROWD_KV.get(kvKey, "json") || [];
    const cutoff = Date.now() - HISTORY_TTL * 1000;
    const points = stored.filter(p => p.t > cutoff);

    return jsonResponse({
      airport: code,
      points,
      count: points.length,
    }, 200, corsHeaders);
  } catch (err) {
    return jsonResponse({ error: "Failed to read history", details: err.message }, 500, corsHeaders);
  }
}
