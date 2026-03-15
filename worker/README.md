# TSA Wait Times Proxy (Cloudflare Worker)

This Cloudflare Worker proxies requests to the official **TSA MyTSA Web Service** (`apps.tsa.dhs.gov`) and adds CORS headers so the AirQ static site can fetch real TSA data.

## Setup

1. Install Wrangler (Cloudflare's CLI):
   ```bash
   npm install -g wrangler
   ```

2. Log in to Cloudflare:
   ```bash
   wrangler login
   ```

3. Deploy:
   ```bash
   cd worker
   npx wrangler deploy
   ```

4. After deploy, you'll get a URL like:
   ```
   https://tsa-proxy.YOUR_SUBDOMAIN.workers.dev
   ```

5. Update `TSA_PROXY_URL` in `app.js` with your worker URL.

## Usage

```
GET https://tsa-proxy.YOUR_SUBDOMAIN.workers.dev?airport=LAX
```

Returns:
```json
{
  "airport": "LAX",
  "timestamp": "2026-03-15T...",
  "source": "TSA MyTSA Web Service (apps.tsa.dhs.gov)",
  "data": { ... }
}
```

## Free Tier Limits

Cloudflare Workers free tier: **100,000 requests/day** — more than enough for a personal project.

## Local Development

```bash
cd worker
npx wrangler dev
```

This starts a local server at `http://localhost:8787` for testing.
