import crypto from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import { PlanPaymentModel } from "../models/PlanPayment.js";
import { getPlanBySlugFromRegistry } from "../services/planRegistry.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createParameter, createTransaction } from "../utils/midtrans.js";
import { toAbsoluteUrlFromRequest } from "../utils/publicOriginFromRequest.js";

const planPaymentBodySchema = z.object({
  planSlug: z.string().trim().min(1),
});

function frontendAppUrl(): string {
  return (process.env.PUBLIC_APP_URL ?? process.env.FE_LINK ?? "http://localhost:3000").replace(/\/$/, "");
}

function paymentApiUrl(request: FastifyRequest, path: string): string {
  return toAbsoluteUrlFromRequest(request, path) ?? `http://localhost:${process.env.PORT ?? 8000}${path}`;
}

function verifyMidtransSignature(body: Record<string, unknown>): boolean {
  const serverKey = process.env.MIDTRANS_SERVER_KEY?.trim();
  if (!serverKey) return false;

  const orderId = String(body.order_id ?? "");
  const statusCode = String(body.status_code ?? "");
  const grossAmount = String(body.gross_amount ?? "");
  const signatureKey = String(body.signature_key ?? "");
  if (!orderId || !signatureKey) return false;

  const expected = crypto
    .createHash("sha512")
    .update(orderId + statusCode + grossAmount + serverKey)
    .digest("hex");
  return signatureKey === expected;
}

function isMidtransPaid(transactionStatus: string, fraudStatus: string): boolean {
  const paidStatus = transactionStatus === "capture" || transactionStatus === "settlement";
  if (!paidStatus) return false;
  return !fraudStatus || fraudStatus === "accept";
}

async function applyMidtransStatus(orderId: string, transactionStatus: string, fraudStatus: string) {
  if (!mongoose.Types.ObjectId.isValid(orderId)) return null;

  const payment = await PlanPaymentModel.findById(orderId);
  if (!payment) return null;

  if (isMidtransPaid(transactionStatus, fraudStatus)) {
    if (!payment.isPaid) {
      payment.isPaid = true;
      payment.paidAt = new Date();
      await payment.save();
    }
    return payment;
  }

  // ponytail: pending/deny/cancel/expire stay isPaid=false until paid webhook
  return payment;
}

export async function registerPaymentRoutes(fastify: FastifyInstance): Promise<void> {
  /** Midtrans Payment Notification URL (configure in Midtrans dashboard). */
  fastify.post("/api/v1/payments/midtrans/notification", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!verifyMidtransSignature(body)) {
      return sendError(reply, "Invalid Midtrans signature.", 403, "INVALID_SIGNATURE");
    }

    const orderId = String(body.order_id ?? "").trim();
    const transactionStatus = String(body.transaction_status ?? "").trim();
    const fraudStatus = String(body.fraud_status ?? "accept").trim();
    const grossAmount = Number(body.gross_amount);

    const payment = await PlanPaymentModel.findById(orderId);
    if (!payment) {
      return sendError(reply, "Payment not found.", 404, "NOT_FOUND");
    }
    if (Number.isFinite(grossAmount) && grossAmount !== payment.amount) {
      return sendError(reply, "Payment amount mismatch.", 400, "AMOUNT_MISMATCH");
    }

    await applyMidtransStatus(orderId, transactionStatus, fraudStatus);
    request.log.info({ orderId, transactionStatus, fraudStatus }, "midtrans notification handled");
    return reply.code(200).send({ ok: true });
  });

  /** Midtrans Finish Redirect URL (set as callbacks.finish when creating Snap transaction). */
  fastify.get("/api/v1/payments/finish", async (request, reply) => {
    const query = request.query as {
      order_id?: string;
      transaction_status?: string;
      status_code?: string;
    };
    const orderId = query.order_id?.trim() ?? "";
    const transactionStatus = query.transaction_status?.trim() ?? "";
    const appUrl = frontendAppUrl();

    if (!orderId) {
      return reply.redirect(`${appUrl}/payment/status?error=missing_order`);
    }

    const payment = await PlanPaymentModel.findById(orderId);
    if (payment && transactionStatus) {
      await applyMidtransStatus(orderId, transactionStatus, "accept");
    }

    const params = new URLSearchParams({ paymentId: orderId });
    if (transactionStatus) params.set("status", transactionStatus);
    if (payment) {
      params.set("isPaid", payment.isPaid ? "1" : "0");
      params.set("planSlug", payment.planSlug);
    } else {
      params.set("error", "not_found");
    }

    return reply.redirect(`${appUrl}/payment/status?${params.toString()}`);
  });

  fastify.post("/api/v1/payments/plan", { preHandler: requireBearerUser }, async (request, reply) => {
    const body = planPaymentBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, body.error.issues[0]?.message ?? "Invalid request body.", 400, "INVALID_BODY");
    }

    const planSlug = body.data.planSlug.trim().toLowerCase();
    const plan = getPlanBySlugFromRegistry(planSlug);
    const grossAmount = plan?.midtrans.grossAmount ?? null;

    if (!plan || !plan.isActive || !plan.showOnPricingPage || grossAmount == null || grossAmount <= 0) {
      return sendError(reply, "This plan is not available for checkout.", 400, "PLAN_NOT_PAYABLE");
    }

    const user = request.bearerUser;
    if (!user) {
      return sendError(reply, "Authentication required.", 401, "UNAUTHORIZED");
    }
    if (user.isBlocked) {
      return sendError(reply, "Account is blocked.", 403, "USER_BLOCKED");
    }

    request.log.info(
      { planSlug, planName: plan.name, userId: user._id.toString() },
      "plan payment started",
    );

    const session = await mongoose.startSession();
    try {
      let paymentId = "";
      let redirectUrl = "";

      await session.withTransaction(async () => {
        const [payment] = await PlanPaymentModel.create(
          [{ userId: user._id, planSlug, amount: grossAmount, isPaid: false }],
          { session },
        );

        const parameter = {
          ...createParameter({
            order_id: payment._id.toString(),
            gross_amount: grossAmount,
            email: user.email,
          }),
          callbacks: {
            finish: paymentApiUrl(request, "/api/v1/payments/finish"),
          },
        };
        const midtrans = await createTransaction(parameter);
        if (!midtrans) {
          throw new Error("MIDTRANS_FAILED");
        }

        payment.transactionToken = midtrans.transactionToken;
        await payment.save({ session });

        paymentId = payment._id.toString();
        redirectUrl = midtrans.redirectUrl;
      });

      return sendSuccess(reply, {
        paymentId,
        planSlug,
        planName: plan.name,
        amount: grossAmount,
        redirectUrl,
      });
    } catch (e) {
      if (e instanceof Error && e.message === "MIDTRANS_FAILED") {
        return sendError(reply, "Failed to start payment with Midtrans.", 502, "MIDTRANS_FAILED");
      }
      const message = e instanceof Error ? e.message : "Failed to start payment.";
      return sendError(reply, message, 500, "PAYMENT_START_FAILED");
    } finally {
      await session.endSession();
    }
  });
}
