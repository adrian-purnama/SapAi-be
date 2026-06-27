import midtransClient from "midtrans-client";

const snap = new midtransClient.Snap({
  isProduction: process.env.NODE_ENV !== "development",
  serverKey: process.env.MIDTRANS_SERVER_KEY ?? "",
  clientKey: process.env.MIDTRANS_CLIENT_KEY ?? "",
});

export function createParameter(transaction: any) {
  return {
    transaction_details: {
      order_id: transaction.order_id,
      gross_amount: transaction.gross_amount,
    },
    credit_card: { secure: true },
    customer_details: {
      email: transaction.email,
    },
  };
}

export async function createTransaction(
  parameter: any,
): Promise<{ transactionToken: string; redirectUrl: string } | null> {
  try {
    const transaction = await snap.createTransaction(parameter);
    const transactionToken = transaction.token ?? null;
    const redirectUrl = transaction.redirect_url ?? null;
    if (!transactionToken || !redirectUrl) return null;
    return { transactionToken, redirectUrl };
  } catch (error: any) {
    console.log("error:", error);
    return null;
  }
}
