import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";

import { requireApiKey } from "../auth/requireApiKey.js";
import { requireBearerAdmin } from "../auth/requireBearerUser.js";
import { ChatJobModel } from "../models/ChatJob.js";
import { UserModel } from "../models/User.js";
import { sendPasswordResetEmail } from "../services/brevoService.js";
import { hashPassword } from "../services/passwordService.js";
import { upsertOtpForEmail } from "../services/otpService.js";
import { validatePasswordForAuth } from "../utils/passwordInput.js";
import { PlanModel } from "../models/Plan.js";
import { syncUserApiKeysToPlan } from "../services/apiKeyPlanSyncService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";

const USER_PLAN_POPULATE = { path: "plan", select: "slug name" } as const;

function mapPopulatedPlan(plan: unknown): { id: string; slug: string; name: string } | null {
  if (!plan || typeof plan !== "object" || !("_id" in plan)) return null;
  const p = plan as { _id: mongoose.Types.ObjectId; slug: string; name: string };
  return { id: p._id.toString(), slug: p.slug, name: p.name };
}

function mapAdminUser(u: {
  _id: mongoose.Types.ObjectId;
  email: string;
  isAdmin?: boolean;
  isEmailVerified?: boolean;
  isBlocked?: boolean;
  plan?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: u._id.toString(),
    email: u.email,
    emailMasked: maskEmail(u.email),
    isAdmin: Boolean(u.isAdmin),
    isEmailVerified: Boolean(u.isEmailVerified),
    isBlocked: Boolean(u.isBlocked),
    plan: mapPopulatedPlan(u.plan),
    createdAt: u.createdAt ?? null,
    updatedAt: u.updatedAt ?? null,
  };
}

function maskEmail(email: string): string {
  const e = String(email || "").trim();
  const [localRaw, domainRaw] = e.split("@");
  const local = (localRaw ?? "").trim();
  const domain = (domainRaw ?? "").trim();
  if (!local || !domain) return "—";
  const first = local[0] ?? "*";
  const last = local.length > 1 ? local[local.length - 1] : "*";
  const stars = local.length <= 2 ? "*" : "*".repeat(Math.min(6, local.length - 2));
  return `${first}${stars}${last}@${domain}`;
}

export async function registerUserRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * API-key scoped "me" — useful for embedded clients to check plan, token balance, and queue status.
   * Auth: `x-api-key`.
   */
  fastify.get("/api/v1/api-key/me", { preHandler: requireApiKey }, async (request, reply) => {
    const auth = request.apiAuth!;
    if (!mongoose.Types.ObjectId.isValid(auth.userId) || !mongoose.Types.ObjectId.isValid(auth.apiKeyId)) {
      return sendError(reply, "Invalid auth context.", 401, "INVALID_AUTH_CONTEXT");
    }

    const user = await UserModel.findById(auth.userId).populate(USER_PLAN_POPULATE).lean();
    if (!user) return sendError(reply, "User not found.", 401, "USER_NOT_FOUND");

    const apiKeyId = new mongoose.Types.ObjectId(auth.apiKeyId);
    const activeStatuses = ["pending", "queued", "running", "streaming"] as const;

    const [activeJobs, lastJob] = await Promise.all([
      ChatJobModel.countDocuments({ apiKeyId, status: { $in: [...activeStatuses] } }),
      ChatJobModel.findOne({ apiKeyId }).sort({ createdAt: -1 }).select({ createdAt: 1, status: 1 }).lean(),
    ]);

    return sendSuccess(reply, {
      apiKey: { id: auth.apiKeyId, label: auth.label, prefix: auth.prefix },
      user: {
        id: auth.userId,
        emailMasked: maskEmail(user.email),
        plan: mapPopulatedPlan(user.plan),
        isBlocked: Boolean(user.isBlocked),
      },
      jobs: {
        active: activeJobs,
        lastJobAt: lastJob?.createdAt ?? null,
        lastJobStatus: (lastJob as { status?: string } | null)?.status ?? null,
      },
      serverTime: new Date().toISOString(),
    });
  });

  /**
   * Admin user management.
   * Auth: `Authorization: Bearer <token>` (admin).
   */
  fastify.get("/api/v1/admin/users", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(25),
        q: z.string().optional(),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return sendError(reply, "Invalid query.", 400, "INVALID_QUERY");

    const page = query.data.page;
    const limit = query.data.limit;
    const q = query.data.q?.trim().toLowerCase() || "";

    const filter: Record<string, unknown> = {};
    if (q) {
      filter.email = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    }

    const [total, users] = await Promise.all([
      UserModel.countDocuments(filter),
      UserModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({
          email: 1,
          isAdmin: 1,
          isEmailVerified: 1,
          isBlocked: 1,
          plan: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .lean(),
    ]);

    return sendSuccess(reply, {
      page,
      limit,
      total,
      users: users.map((u) => mapAdminUser(u)),
    });
  });

  fastify.get("/api/v1/admin/users/:id", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid user id.", 400, "INVALID_PARAMS");
    const id = params.data.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return sendError(reply, "Invalid user id.", 400, "INVALID_USER_ID");

    const user = await UserModel.findById(id)
      .populate(USER_PLAN_POPULATE)
      .select({
        email: 1,
        isAdmin: 1,
        isEmailVerified: 1,
        isBlocked: 1,
        plan: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .lean();
    if (!user) return sendError(reply, "User not found.", 404, "USER_NOT_FOUND");

    return sendSuccess(reply, { user: mapAdminUser(user) });
  });

  fastify.patch("/api/v1/admin/users/:id", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid user id.", 400, "INVALID_PARAMS");
    const id = params.data.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return sendError(reply, "Invalid user id.", 400, "INVALID_USER_ID");

    const body = z
      .object({
        planId: z.string().optional(),
        isBlocked: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!body.success) return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");

    const update: Record<string, unknown> = {};
    if (body.data.planId !== undefined) {
      const planId = body.data.planId.trim();
      if (!planId) {
        update.plan = null;
      } else {
        if (!mongoose.Types.ObjectId.isValid(planId)) {
          return sendError(reply, "Invalid plan id.", 400, "INVALID_PLAN_ID");
        }
        const planExists = await PlanModel.exists({ _id: new mongoose.Types.ObjectId(planId) });
        if (!planExists) return sendError(reply, "Plan not found.", 404, "PLAN_NOT_FOUND");
        update.plan = new mongoose.Types.ObjectId(planId);
      }
    }
    if (typeof body.data.isBlocked === "boolean") update.isBlocked = body.data.isBlocked;

    const user = await UserModel.findByIdAndUpdate(id, { $set: update }, { new: true })
      .populate(USER_PLAN_POPULATE)
      .lean();
    if (!user) return sendError(reply, "User not found.", 404, "USER_NOT_FOUND");

    let apiKeySync: Awaited<ReturnType<typeof syncUserApiKeysToPlan>> | undefined;
    if (body.data.planId !== undefined) {
      apiKeySync = await syncUserApiKeysToPlan(new mongoose.Types.ObjectId(id));
    }

    return sendSuccess(reply, {
      message: "User updated.",
      user: mapAdminUser(user),
      ...(apiKeySync ? { apiKeySync } : {}),
    });
  });

  fastify.post("/api/v1/admin/users/:id/send-password-reset", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid user id.", 400, "INVALID_PARAMS");
    const id = params.data.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return sendError(reply, "Invalid user id.", 400, "INVALID_USER_ID");

    const user = await UserModel.findById(id).lean();
    if (!user) return sendError(reply, "User not found.", 404, "USER_NOT_FOUND");

    const upsert = await upsertOtpForEmail(user.email, "password_reset");
    if (!upsert.ok) {
      reply.header("Retry-After", String(upsert.retryAfterSec));
      return sendError(
        reply,
        "Please wait before sending another reset code.",
        429,
        "OTP_RESEND_COOLDOWN",
      );
    }
    await sendPasswordResetEmail(user.email, upsert.otp);

    return sendSuccess(reply, { message: "Password reset email sent." });
  });

  fastify.post("/api/v1/admin/users/:id/set-password", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid user id.", 400, "INVALID_PARAMS");
    const id = params.data.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return sendError(reply, "Invalid user id.", 400, "INVALID_USER_ID");

    const body = z.object({ newPassword: z.string() }).safeParse(request.body);
    if (!body.success) return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");
    const err = validatePasswordForAuth(body.data.newPassword);
    if (err) return sendError(reply, err, 400, "WEAK_PASSWORD");

    const user = await UserModel.findById(id);
    if (!user) return sendError(reply, "User not found.", 404, "USER_NOT_FOUND");
    user.passwordHash = await hashPassword(body.data.newPassword);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    return sendSuccess(reply, { message: "Password updated." });
  });
}

