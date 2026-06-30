import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";

import { requireBearerUser } from "../auth/requireBearerUser.js";
import { PlanPaymentModel, type PlanPaymentLean } from "../models/PlanPayment.js";
import { UserModel } from "../models/User.js";
import {
  getPlanBySlugFromRegistry,
  isUserPlanExpired,
  resolveEffectivePlanForUser,
  resolvePlanForUser,
  type PlanSnapshot,
} from "../services/planRegistry.js";
import { syncUserApiKeysToPlan } from "../services/apiKeyPlanSyncService.js";
import { appendUserPlanHistory } from "../services/userPlanHistoryService.js";
import { endOfUtcDay } from "../utils/planAccess.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import {
  createParameter,
  createTransaction,
  getMidtransServerKey,
  verifyMidtransNotificationSignature,
} from "../utils/midtrans.js";
import { toAbsoluteUrlFromRequest } from "../utils/publicOriginFromRequest.js";

const planPaymentBodySchema = z.object({
  planSlug: z.string().trim().min(1),
});

/** Paid plan length applied on successful checkout (days). */
const PLAN_PURCHASE_DURATION_DAYS = 35;

type PlanCheckoutDecision =
  | { ok: true; description: string; validUntil: Date; durationDays: number }
  | { ok: false; status: number; message: string; code: string };

function formatPlanUntilUtc(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function assessPlanCheckout(
  user: { plan?: unknown; planExpiresAt?: Date | null; isEmailVerified?: boolean },
  targetPlan: PlanSnapshot,
): PlanCheckoutDecision {
  if (!user.isEmailVerified) {
    return {
      ok: false,
      status: 403,
      message: "Verify your email before purchasing a plan.",
      code: "EMAIL_NOT_VERIFIED",
    };
  }
  if (targetPlan.isDefault) {
    return {
      ok: false,
      status: 400,
      message: "This plan is not available for checkout.",
      code: "PLAN_NOT_PAYABLE",
    };
  }

  const assigned = resolvePlanForUser(user.plan);
  const expired = isUserPlanExpired({ plan: user.plan, planExpiresAt: user.planExpiresAt });
  const hasActivePaid = !expired && assigned != null && !assigned.isDefault;

  if (hasActivePaid && assigned.slug === targetPlan.slug) {
    return {
      ok: false,
      status: 409,
      message: `You already have an active ${targetPlan.name} subscription.`,
      code: "PLAN_ALREADY_ACTIVE",
    };
  }

  const effective = resolveEffectivePlanForUser({ plan: user.plan, planExpiresAt: user.planExpiresAt });
  if (hasActivePaid && effective && !effective.isDefault && targetPlan.sortOrder <= effective.sortOrder) {
    return {
      ok: false,
      status: 400,
      message: "You can only upgrade to a higher-tier plan.",
      code: "PLAN_DOWNGRADE_NOT_ALLOWED",
    };
  }

  const durationDays = PLAN_PURCHASE_DURATION_DAYS;
  const validUntil = endOfUtcDay(new Date(Date.now() + durationDays * 86_400_000));
  const untilLabel = formatPlanUntilUtc(validUntil);
  const description = `Buy ${targetPlan.name} plan (${durationDays} days, valid until ${untilLabel} UTC)`;

  return { ok: true, description, validUntil, durationDays };
}

function frontendAppUrl(): string {
  return (process.env.PUBLIC_APP_URL ?? process.env.FE_LINK ?? "http://localhost:3000").replace(/\/$/, "");
}

function paymentApiUrl(request: FastifyRequest, path: string): string {
  return toAbsoluteUrlFromRequest(request, path) ?? `http://localhost:${process.env.PORT ?? 8000}${path}`;
}

function isMidtransPaid(transactionStatus: string, fraudStatus: string): boolean {
  const paidStatus = transactionStatus === "capture" || transactionStatus === "settlement";
  if (!paidStatus) return false;
  return !fraudStatus || fraudStatus === "accept";
}

async function grantUserPlanFromPayment(payment: PlanPaymentLean & { _id: mongoose.Types.ObjectId }): Promise<void> {
  const plan = getPlanBySlugFromRegistry(String(payment.planSlug));
  if (!plan) return;

  const rawUntil = payment.validUntil;
  let validUntil: Date;
  if (rawUntil instanceof Date) {
    validUntil = rawUntil;
  } else if (rawUntil) {
    const parsed = new Date(String(rawUntil));
    validUntil = Number.isNaN(parsed.getTime())
      ? endOfUtcDay(new Date(Date.now() + (payment.durationDays ?? PLAN_PURCHASE_DURATION_DAYS) * 86_400_000))
      : parsed;
  } else {
    validUntil = endOfUtcDay(new Date(Date.now() + (payment.durationDays ?? PLAN_PURCHASE_DURATION_DAYS) * 86_400_000));
  }

  await UserModel.findByIdAndUpdate(payment.userId, {
    $set: {
      plan: new mongoose.Types.ObjectId(plan.id),
      planExpiresAt: validUntil,
    },
  });

  await appendUserPlanHistory({
    userId: payment.userId,
    kind: "assigned",
    planSlug: plan.slug,
    planName: plan.name,
    planExpiresAt: validUntil,
    actor: "system",
  });

  await syncUserApiKeysToPlan(payment.userId as mongoose.Types.ObjectId);
}

async function settlePaidPlanPayment(
  orderId: string,
  transactionStatus: string,
  fraudStatus: string,
): Promise<(PlanPaymentLean & { _id: mongoose.Types.ObjectId }) | null> {
  if (!mongoose.Types.ObjectId.isValid(orderId) || !isMidtransPaid(transactionStatus, fraudStatus)) {
    return null;
  }

  const payment = await PlanPaymentModel.findOneAndUpdate(
    { _id: orderId, isPaid: false },
    { $set: { isPaid: true, paidAt: new Date() } },
    { new: true },
  ).lean();
  if (!payment) return null;

  await grantUserPlanFromPayment(payment as PlanPaymentLean & { _id: mongoose.Types.ObjectId });
  return payment as PlanPaymentLean & { _id: mongoose.Types.ObjectId };
}

export async function registerPaymentRoutes(fastify: FastifyInstance): Promise<void> {
  /** Midtrans Payment Notification URL (configure in Midtrans dashboard). */
  fastify.post("/api/v1/payments/midtrans/notification", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!getMidtransServerKey()) {
      request.log.error("MIDTRANS_SERVER_KEY is missing");
      return sendError(reply, "Payment gateway not configured.", 503, "MIDTRANS_NOT_CONFIGURED");
    }
    if (!verifyMidtransNotificationSignature(body)) {
      request.log.warn({ orderId: body.order_id }, "midtrans notification signature mismatch");
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

    await settlePaidPlanPayment(orderId, transactionStatus, fraudStatus);
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

    // ponytail: finish is display-only; webhook settles payment + grants plan
    const payment = await PlanPaymentModel.findById(orderId);

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
    if (!getMidtransServerKey()) {
      return sendError(reply, "Payment gateway not configured.", 503, "MIDTRANS_NOT_CONFIGURED");
    }

    const checkout = assessPlanCheckout(user, plan);
    if (!checkout.ok) {
      return sendError(reply, checkout.message, checkout.status, checkout.code);
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
          [
            {
              userId: user._id,
              planSlug,
              amount: grossAmount,
              description: checkout.description,
              durationDays: checkout.durationDays,
              validUntil: checkout.validUntil,
              isPaid: false,
            },
          ],
          { session },
        );

        const parameter = {
          ...createParameter({
            order_id: payment._id.toString(),
            gross_amount: grossAmount,
            email: user.email,
            planSlug,
            description: checkout.description,
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
        description: checkout.description,
        validUntil: checkout.validUntil.toISOString(),
        durationDays: checkout.durationDays,
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
