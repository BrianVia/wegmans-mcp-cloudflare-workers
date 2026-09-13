# wegmans-mcp-cloudflare-workers

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server for Wegmans, hosted on Cloudflare Workers. It searches products and stores, manages one user's cart, syncs purchase history, and predicts what may be needed next.

One Worker serves a bearer-protected, stateless `/mcp` endpoint. A Durable Object owns the Wegmans access and refresh tokens, while KV stores purchase history.

```text
MCP client ──Bearer──▶ Worker ──▶ Wegmans and Algolia APIs
                         │
                         ├── Durable Object: login tokens
                         └── KV: purchase history
```

## Setup

```sh
npm install
npx wrangler login
npx wrangler kv namespace create DATA     # prints the namespace id
```

Copy `wrangler.jsonc` to `wrangler.local.jsonc` (gitignored) and fill in three values: the custom domain (a hostname on a zone you manage in Cloudflare), the KV namespace id from above, and your default `WEGMANS_STORE` number (use the `find_stores` tool to look it up). Deploy with `WRANGLER_CONFIG=wrangler.local.jsonc npm run deploy` — or edit `wrangler.jsonc` in place if you don't care about keeping those out of git. The custom-domain route creates the DNS record on first deploy.

Your Wegmans customer ID is a UUID assigned to your account. Log into [wegmans.com](https://www.wegmans.com), open DevTools (F12), select the Network tab, find a request to `algolia.net`, and copy the `userToken` value from its request body.

## Deploy

```sh
npm run deploy
npx wrangler secret put WEGMANS_EMAIL
npx wrangler secret put WEGMANS_PASSWORD
npx wrangler secret put WEGMANS_CUSTOMER_ID
openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put MCP_BEARER
```

The first authenticated tool call logs in through Microsoft Azure B2C. Check status with:

```sh
curl -s https://wegmans.example.com/health
```

Then call `sync_purchase_history` once before using the purchase-pattern tools.

## Tools

| Tool | Auth | Description |
|---|---:|---|
| `search_products` | No | Search products, prices, aisles, and ratings |
| `get_product_details` | No | Get one product by ID |
| `browse_category` | No | Browse a department or category |
| `find_stores` | No | Find stores by name, city, state, ZIP, or number |
| `get_my_items` | No | List frequently purchased products from synced history |
| `add_to_cart` | Yes | Add a product to the Wegmans cart |
| `sync_grocery_note` | Yes | Paste a grocery list; adds only what's missing from the cart, preferring products you've bought before (`dry_run` to preview) |
| `get_food_preferences` / `set_food_preferences` | No | A markdown note of your food preferences ("Wegmans brand when available", "no pork", …). Stored in KV and sent to every MCP client as server instructions on connect, so agents respect it without being told. |
| `get_cart` | Yes | View the current cart |
| `sync_purchase_history` | Yes | Sync receipts, online orders, and rankings |
| `get_purchase_patterns` | No | Analyze purchase intervals and urgency |
| `get_shopping_suggestions` | No | Predict items needed soon |
| `get_product_history` | No | Show one product's purchase timeline |

## Raw HTTP

The endpoint uses stateless Streamable HTTP and returns SSE-framed MCP responses.

```sh
curl -s https://wegmans.example.com/mcp -X POST \
  -H 'Authorization: Bearer <MCP_BEARER>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Local development

```sh
cp .dev.vars.example .dev.vars
npm run check
npx wrangler dev
```

Dummy local secrets are enough for `/health`, product search, and authorization checks. Cart calls return an MCP error result until valid Wegmans credentials are supplied.

## Limits and notes

- The Wegmans password is a Worker secret and is sent only to Microsoft's Wegmans Azure B2C login endpoint.
- `/mcp` requires `MCP_BEARER`; `/` and `/health` are public.
- One sync runs inline. Cloudflare Workers Paid permits 1,000 subrequests per request; split syncing into Durable Object alarm batches if an account exceeds that order ceiling.
- Product availability, pricing, and aisle locations depend on `WEGMANS_STORE`, which defaults to `133`.

## License

MIT. See [LICENSE](LICENSE).
