# AirQ Cloudflare Worker — TSA Proxy + Crowd Reports

This worker handles two things:
1. **TSA Proxy** — proxies the official TSA MyTSA Web Service with CORS headers
2. **Crowd Reports** — shared crowdsourced wait times via Cloudflare KV

## Setup

1. Install Wrangler:
   ```bash
   npm install -g wrangler
   ```

2. Log in to Cloudflare:
   ```bash
   wrangler login
   ```

3. Create the KV namespace for crowd reports:
   ```bash
   cd worker
   npx wrangler kv namespace create CROWD_KV
   ```
   Copy the generated `id` into `wrangler.toml`.

4. Deploy:
   ```bash
   npx wrangler deploy
   ```

5. Update `TSA_PROXY_URL` in `app.js` with your worker URL.

## API

### TSA Wait Times
```
GET /?airport=LAX
→ { airport, timestamp, source, data }
```

### Get Crowd Reports
```
GET /crowd?airport=LAX
→ { airport, reports: [...], count }
```

### Submit Crowd Report
```
POST /crowd
Content-Type: application/json
{ "airportCode": "LAX", "terminal": "Terminal 1", "type": "standard", "waitMinutes": 15 }
→ { success, report, totalReports }
```

## Free Tier Limits

- **Workers**: 100,000 requests/day
- **KV**: 100,000 reads/day, 1,000 writes/day (plenty for crowd reports)

## Local Development

```bash
cd worker
npx wrangler dev
```
