import { getAccessToken } from "./tokens.js";

const RECEIPTS_API =
  "https://api.digitaldevelopment.wegmans.cloud/commerce/receipts?api-version=2024-09-16-preview";

export interface ReceiptDiscount {
  amount: number;
  type: string;
}

export interface ReceiptItem {
  itemNumber: string;
  productNameCopy: string;
  departmentNumber: number;
  departmentName: string;
  imageUrl: string;
  packSize: string;
  unitPrice: number;
  discountedUnitPrice?: number;
  quantity: number;
  weight: number;
  totalPrice: number;
  discountedTotalPrice: number;
  discounts: ReceiptDiscount[];
}

export interface ReceiptPayment {
  paymentMethod: string;
  cardType: string;
  lastFour: number;
  amount: number;
}

export interface Receipt {
  id: string;
  type: string;
  purchaseTimestamp: string;
  storeNumber: number;
  laneNumber: number;
  subTotal: number;
  taxTotal: number;
  orderTotal: number;
  payments: ReceiptPayment[];
  items: ReceiptItem[];
}

interface ReceiptsResponse {
  pageSize: number;
  totalCount: number;
  data: Receipt[];
}

export async function fetchReceipts(): Promise<Receipt[]> {
  const token = await getAccessToken();
  const res = await fetch(RECEIPTS_API, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      origin: "https://www.wegmans.com",
      referer: "https://www.wegmans.com/",
    },
  });

  if (!res.ok) {
    throw new Error(`Receipts API error: ${res.status}`);
  }

  const data = (await res.json()) as ReceiptsResponse;
  return data.data;
}
