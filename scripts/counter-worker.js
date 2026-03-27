// Cloudflare Worker — Anonymous Visitor Counter
// Deploy: npx wrangler deploy scripts/counter-worker.js --name cc-counter
//
// Prerequisites:
//   1. Create a free Cloudflare account at https://dash.cloudflare.com
//   2. Install Wrangler: npm install -g wrangler
//   3. Create a KV namespace: npx wrangler kv:namespace create COUNTER
//   4. Add the binding to wrangler.toml (see below)
//   5. Deploy this worker
//   6. Set CC_COUNTER_URL in index.html to your worker URL
//
// wrangler.toml:
//   name = "cc-counter"
//   main = "scripts/counter-worker.js"
//   compatibility_date = "2024-01-01"
//   [[kv_namespaces]]
//   binding = "COUNTER"
//   id = "<your-kv-namespace-id>"
//
// GDPR notes:
// - Stores only a single integer (the count)
// - No IP addresses, no timestamps, no user agents
// - No cookies set, no fingerprinting
// - Request bodies/headers are not logged

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
        },
      });
    }

    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    };

    // POST = increment counter
    if (request.method === 'POST') {
      const val = parseInt(await env.COUNTER.get('visitors') || '0', 10);
      await env.COUNTER.put('visitors', String(val + 1));
      return new Response(JSON.stringify({ count: val + 1 }), { headers });
    }

    // GET = read counter (for your own dashboard)
    const val = parseInt(await env.COUNTER.get('visitors') || '0', 10);
    return new Response(JSON.stringify({ count: val }), { headers });
  },
};
