# Improvements

Tracked issues and enhancements for the Wegmans MCP server.

## Real Issues

- [ ] **Phantom zod dependency** — `zod` is imported in `index.ts` but only resolves via `@modelcontextprotocol/sdk` transitive dep. Add it to `package.json` directly. *(Handled by parallel work on `package.json`.)*
- [ ] **Move build deps to devDependencies** — `@types/node` and `typescript` belong in `devDependencies`, not `dependencies`. *(Handled by parallel work on `package.json`.)*
- [x] **Algolia credentials duplicated 3x** — `algolia.ts`, `cart.ts:63-64`, `index.ts:76-77` all define the same constants. Centralize in `algolia.ts` and import. *(Done: `algolia.ts` exports an `algoliaQuery` helper; `cart.ts`, `index.ts`, and `my-items.ts` all route through it.)*
- [x] **`get_product_details` duplicates `lookupProduct`** — `index.ts:74-116` reimplements the same Algolia query that `cart.ts:lookupProduct()` already does. Reuse it. *(Done: `lookupProduct` now lives in `algolia.ts` (re-exported from `cart.ts`) and `get_product_details` calls it.)*
- [x] **Dead code: `getMyItems()` in my-items.ts** — Lines 41-81 are never called. Only `queryProductsByIds` is used. Remove or mark explicitly as experimental. *(Done: removed.)*

## Structural Improvements

- [x] **`get_cart` returns raw JSON** — Every other tool formats output nicely. This one just dumps `JSON.stringify`. Format it: item name, quantity, price. *(Done: per-line name/qty/unit price/line total plus item count and subtotal, with raw-JSON fallback if the response shape changes.)*
- [ ] **No refresh token usage** — `auth.ts` receives `refresh_token` but never uses it. Full re-login on every token expiry. Use the refresh token for faster, less fragile re-auth. *(Handled by parallel work on `auth.ts`.)*
- [x] **Cart merge is client-side with silent failure** — `getCurrentCartLineItems` returns `[]` on fetch error (line 111), meaning a failed read + write could overwrite the real cart with just the new item. Should throw on error instead. *(Done: cart GET and store-key lookup both throw with status + body; existing line items now keep the cart's own store/fulfillment channel and per-item attributes from the GET response instead of being stamped with the new call's arguments.)*
- [x] **`savePurchaseHistory` writes without pretty-print** — 893KB single-line JSON. Add `null, 2` to `JSON.stringify` for debuggability. *(Done.)*
- [ ] **Order fetching uses hard-coded batch size** — `fetchOrders()` fetches details in serial batches of 5. Could use a concurrency limiter with `Promise.all` for better throughput. *(Partial: failed detail fetches are now counted and surfaced in `sync_purchase_history` output instead of being silently dropped; batching unchanged.)*

## Nice-to-haves

- [x] **Add project-level CLAUDE.md** — Document API quirks, auth flow nuances, which tools are legacy vs active. *(Done: `CLAUDE.md` at repo root.)*
- [ ] **Fill in `author` field in package.json**
- [ ] **Consider retiring `refresh_my_items` tool** — `sync_purchase_history` supersedes the manual "paste Algolia payload from DevTools" flow. Adds surface area to the tool list without much benefit.
