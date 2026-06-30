import crypto from "node:crypto";

import midtransClient from "midtrans-client";

import { stripQuotes } from "./env.js";
import { isProductionEnvironment } from "./sanitizeError.js";

export function getMidtransServerKey(): string {
  return stripQuotes(process.env.MIDTRANS_SERVER_KEY ?? "").trim();
}

function isMidtransProduction(): boolean {
  const raw = process.env.MIDTRANS_IS_PRODUCTION?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return isProductionEnvironment();
}

/** Midtrans signs SHA512(order_id + status_code + gross_amount + ServerKey). */
function grossAmountForSignature(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  return String(value ?? "");
}

export function verifyMidtransNotificationSignature(body: Record<string, unknown>): boolean {
  const serverKey = getMidtransServerKey();
  if (!serverKey) return false;

  const orderId = String(body.order_id ?? "");
  const statusCode = String(body.status_code ?? "");
  const grossAmount = grossAmountForSignature(body.gross_amount);
  const signatureKey = String(body.signature_key ?? "").trim();
  if (!orderId || !signatureKey) return false;

  const expected = crypto
    .createHash("sha512")
    .update(orderId + statusCode + grossAmount + serverKey)
    .digest("hex");

  if (expected.length !== signatureKey.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signatureKey, "utf8"));
  } catch {
    return false;
  }
}

const snap = new midtransClient.Snap({
  isProduction: isMidtransProduction(),
  serverKey: getMidtransServerKey(),
  clientKey: stripQuotes(process.env.MIDTRANS_CLIENT_KEY ?? "").trim(),
});

export function createParameter(transaction: {
  order_id: string;
  gross_amount: number;
  email: string;
  planSlug: string;
  description: string;
}) {
  const itemName = transaction.description.slice(0, 50);
  return {
    transaction_details: {
      order_id: transaction.order_id,
      gross_amount: transaction.gross_amount,
    },
    item_details: [
      {
        id: transaction.planSlug,
        price: transaction.gross_amount,
        quantity: 1,
        name: itemName,
      },
    ],
    credit_card: { secure: true },
    customer_details: {
      email: transaction.email,
    },
    custom_field1: transaction.description.slice(0, 255),
  };
}

export async function createTransaction(
  parameter: Parameters<typeof snap.createTransaction>[0],
): Promise<{ transactionToken: string; redirectUrl: string } | null> {
  try {
    const transaction = await snap.createTransaction(parameter);
    const transactionToken = transaction.token ?? null;
    const redirectUrl = transaction.redirect_url ?? null;
    if (!transactionToken || !redirectUrl) return null;
    return { transactionToken, redirectUrl };
  } catch (error: unknown) {
    console.log("error:", error);
    return null;
  }
}
