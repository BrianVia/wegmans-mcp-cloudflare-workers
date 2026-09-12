# Wegmans API Reference

Documented API endpoints discovered from network traffic analysis, API probing, and the [wegmans-shopping](https://github.com/nathannorman-toast/wegmans-shopping) reference project.

All authenticated APIs live at `api.digitaldevelopment.wegmans.cloud` and require:
- `Authorization: Bearer <token>` (from Azure AD B2C)
- `Origin: https://www.wegmans.com`
- `Referer: https://www.wegmans.com/`

## Public APIs (No Auth Required)

### Algolia Product Search

Wegmans uses Algolia for product search. The public search-only API key allows direct queries.

- **URL**: `https://qgppr19v8v-dsn.algolia.net/1/indexes/*/queries`
- **Method**: POST
- **Auth**: Query params `x-algolia-api-key` and `x-algolia-application-id`
- **App ID**: `QGPPR19V8V`
- **API Key**: `9a10b1401634e9a6e55161c3a60c200d` (public search-only key)
- **Index**: `products`

#### Key Filter Fields

| Field | Example | Notes |
|-------|---------|-------|
| `storeNumber` | `133` | Required — products/prices are store-specific |
| `fulfilmentType` | `instore`, `delivery` | Note: "fulfilment" not "fulfillment" |
| `excludeFromWeb` | `false` | Always filter to `false` |
| `isSoldAtStore` | `true` | Filter out non-available items |
| `categoryPageId` | `"Produce"` | For category browsing |

#### Product Fields

| Field | Type | Description |
|-------|------|-------------|
| `productId` | string | Unique product identifier |
| `productName` | string | Display name |
| `brand` | string | Brand name |
| `size` | string | Package size |
| `price_inStore` | `{ amount, unitPrice }` | In-store price |
| `price_delivery` | `{ amount, unitPrice }` | Delivery price |
| `images` | string[] | Product image URLs |
| `category` | array | Hierarchical category chain |
| `categoryPageId` | string[] | Category path (e.g. `"Produce > Fruit > Bananas"`) |
| `planogram.aisle` | string | Physical aisle location in store |
| `filterTags` | string[] | Tags like "Organic", "Wegmans Brand", "Food You Feel Good About" |
| `isSoldByWeight` | boolean | Weight-based pricing |
| `onlineSellByUnit` | string | Unit type (e.g. "Each", "lb") |
| `onlineApproxUnitWeight` | number | Approximate weight per unit |
| `allergensAndWarnings` | string | Allergen info |
| `digitalCouponsOfferIds` | string[] | Available digital coupon IDs |
| `rating` | number | Average rating |
| `reviewCount` | number | Number of reviews |
| `upc` | string | UPC barcode |
| `bottleDeposit` | number | Bottle deposit amount |

#### Rate Limits

From response headers: `x-wegmans-ratelimit: 50000` calls per period.

### Store Locator

- **URL**: `https://www.wegmans.com/api/stores`
- **Method**: GET
- **Auth**: None required

Returns all ~114 Wegmans store locations with:
- `storeNumber` — numeric ID used in Algolia filters
- `name`, `city`, `stateAbbreviation`, `zip`, `streetAddress`
- `latitude`, `longitude`
- `phoneNumber`
- `hasPharmacy`, `hasPickup`, `hasDelivery`, `hasECommerce`
- `sellsAlcohol`, `alcoholTypesForSale`
- `slug` — URL-friendly identifier (e.g. `reston-va`)
- `aislePositionMapping` — JSON mapping of aisle names to sort positions
- `openState` — e.g. "Open"

#### Single Store Lookup

- **URL**: `https://www.wegmans.com/api/stores/store-number/{storeNumber}`
- **Method**: GET

### Categories

- **URL**: `https://www.wegmans.com/api/categories/v3/{fulfillmentType}/{storeNumber}?categoryKeys=[...]`
- **Method**: GET
- **Example**: `/api/categories/v3/instore/133?categoryKeys=["2957335","2952090"]`

## Authenticated APIs

These require Azure AD B2C authentication (OAuth 2.0 + PKCE).

- **Auth Provider**: `myaccount.wegmans.com` (Azure AD B2C)
- **Client ID**: `38c78f8d-d124-4796-8430-1cd476d9a982`
- **Scopes**: Users.Profile.Read/Write, DigitalCoupons.Offers, InstacartConnect.*, Commerce.SignalR, Feedback.Write
- **Base URL**: `https://api.digitaldevelopment.wegmans.cloud`

### Cart — Get Current Cart

- **URL**: `/commerce/cart/carts?api-version=2024-02-19-preview`
- **Method**: GET
- **Returns**: `{ grocery: { id, lineItems[], totalPrice, ... } }`

Each line item includes `variant.sku` (product ID), `name`, `quantity`, `price.value.centAmount`, and `custom.customFieldsRaw[]` with planogram, category, UPC, etc.

### Cart — Set Line Items

- **URL**: `/commerce/cart/carts/lineitems?api-version=2024-02-19-preview`
- **Method**: POST
- **Body**: Full cart state with `StoreKey`, `customerEmail`, `customerID`, and all `lineItems`
- **Note**: This is a **replace** operation — you must include all existing items plus new ones, or existing items will be removed.

### Receipts (In-Store Purchase History)

- **URL**: `/commerce/receipts?api-version=2024-09-16-preview`
- **Method**: GET
- **Returns**: `{ pageSize, totalCount, data: Receipt[] }`

Returns all in-store receipts (observed: 63 receipts spanning 2022–2026). Each receipt includes:

```json
{
  "id": "8b4ca29b-...",
  "type": "InStore",
  "purchaseTimestamp": "2026-02-01T16:39:00+00:00",
  "storeNumber": 146,
  "laneNumber": 10,
  "subTotal": 206.94,
  "taxTotal": 2.69,
  "orderTotal": 207.13,
  "payments": [{ "paymentMethod": "CreditCard", "cardType": "AmericanExpress", "lastFour": 801, "amount": 207.13 }],
  "items": [
    {
      "itemNumber": "55689",
      "productNameCopy": "Blueberry Bagels, 6 Pack",
      "departmentName": "Bakery",
      "imageUrl": "https://images.wegmans.com/...",
      "packSize": "23 ounce",
      "unitPrice": 7.75,
      "discountedUnitPrice": 5.25,
      "quantity": 1,
      "weight": 0,
      "totalPrice": 7.75,
      "discountedTotalPrice": 5.25,
      "discounts": [{ "amount": -2.5, "type": "wegmansShoppersClub" }]
    }
  ]
}
```

### Orders (Online/Pickup Purchase History)

#### List Orders

- **URL**: `/commerce/order/orders?api-version=2024-03-04-preview&offset={n}`
- **Method**: GET
- **Returns**: `{ orders: OrderSummary[], count, offset, total }`
- **Pagination**: Returns 10 per page. Use `offset` param to paginate.

The list response does **not** include line items — only order ID, number, state, and totals.

#### Get Order Detail

- **URL**: `/commerce/order/orders/{orderId}?api-version=2024-03-04-preview`
- **Method**: GET
- **Returns**: `{ orders: [OrderDetail] }` (array with one element)

The detail response includes full `lineItems[]`:

```json
{
  "orderId": "aae80442-...",
  "orderNumber": "Order-2151-7154-6197-3544-9600",
  "orderSubmittedDate": "2026-04-04T14:29:03.158Z",
  "orderState": "Complete",
  "state": { "key": "order-complete", "name": "Order complete" },
  "shipmentState": "Delivered",
  "lineItems": [
    {
      "key": "116893",
      "name": "Lactaid Milk, Reduced Fat, 2% Milkfat",
      "quantity": 2,
      "chargedPricePerUnit": 6.89,
      "variant": { "sku": "116893", "images": [{ "url": "..." }] },
      "lineItemCustom": {
        "category": "Dairy",
        "quantityOrdered": 3,
        "quantityFulfilled": 2,
        "fulfillmentPrice": 6.89,
        "planogram": "{\"aisle\":\"Dairy\",\"shelf\":\"1\"}"
      }
    }
  ]
}
```

**Note**: `quantityOrdered` vs `quantityFulfilled` — the fulfiller may deliver fewer items than ordered if something is out of stock.

### My Items (Purchase Frequency Rankings)

- **URL**: `/commerce/my-items?api-version=2024-01-26`
- **Method**: GET
- **Returns**: `MyItemRecord[]`

Returns all products the user has ever purchased, ranked by frequency, with last purchase date:

```json
[
  { "itemNumber": 116893, "rank": 544, "lastPurchasedDate": "2026-04-04" },
  { "itemNumber": 46155,  "rank": 543, "lastPurchasedDate": "2026-04-04" },
  { "itemNumber": 92685,  "rank": 542, "lastPurchasedDate": "2026-03-31" }
]
```

Observed: 544 items. Higher `rank` = more frequently purchased. `lastPurchasedDate` is a calendar date (no time component).

### Real-time Updates

- **Protocol**: WebSocket via Azure SignalR
- **Used for**: Cart sync, order status updates

## Full API Map

Extracted from Wegmans Next.js frontend JS chunks. All endpoints are under `api.digitaldevelopment.wegmans.cloud`.

| Service | Path | API Version |
|---------|------|-------------|
| Account | `/commerce/account` | `2024-09-12-preview` |
| BazaarVoice | `/bazaar-voice` | — |
| Browse | `/commerce/browse` | — |
| Cart | `/commerce/cart` | `2024-02-19-preview` |
| Cooklist | `/cooklist/graphql` | — |
| Coupons | `/commerce/digital-coupons` | — |
| Feedback | `/feedback` | — |
| Google Address | `/google/address-validation` | `2023-09-08-preview` |
| Instacart Fulfillment | `/commerce/instacart/fulfillment` | `2023-11-13-preview` |
| Instacart Post-Checkout | `/commerce/instacart/post-checkout` | `2024-01-30-preview` |
| **My Items** | **`/commerce/my-items`** | **`2024-01-26`** |
| **Orders** | **`/commerce/order`** | **`2024-03-04-preview`** |
| Payment | `/commerce/payment` | `2024-03-07-preview` |
| **Receipts** | **`/commerce/receipts`** | **`2024-09-16-preview`** |
| Saved Lists | `/commerce/saved-list` | `2024-02-20-preview` |
| SignalR | `/commerce/signalr` | `2024-03-18-preview` |
| User Profile | `/users/profile` | `2023-05-18` |

### Rate Limits

| API | Limit |
|-----|-------|
| Algolia search | 50,000 calls per period |
| Cart API | 5,000 calls per period |
| Other commerce APIs | Unknown (no rate limit headers observed) |

## Third-Party Integrations

| Service | Purpose |
|---------|---------|
| Algolia | Product search |
| Instacart | Delivery/pickup fulfillment |
| Adobe Experience Cloud | Analytics, personalization (AJO) |
| Bazaarvoice | Product reviews |
| LaunchDarkly | Feature flags |
| Riskified | Fraud detection |
