import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";

import { requireBearerAdmin } from "../auth/requireBearerUser.js";
import { CHAT_JOB_STATUS_VALUES, ChatJobModel } from "../models/ChatJob.js";
import { UserModel } from "../models/User.js";
import { CHAT_TASK_TYPES } from "../schemas/chatJobBody.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { toAdminChatJob, toAdminChatJobSummary } from "../utils/toAdminChatJob.js";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  taskType: z.enum(CHAT_TASK_TYPES as unknown as [string, ...string[]]).optional(),
  status: z.enum(CHAT_JOB_STATUS_VALUES).optional(),
  userId: z.string().optional(),
  userEmail: z.string().optional(),
  apiKeyId: z.string().optional(),
  plan: z.string().optional(),
});

export async function registerAdminChatJobRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/admin/chat-jobs", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return sendError(reply, "Invalid query.", 400, "INVALID_QUERY");

    const { page, limit, taskType, status, userId, userEmail, apiKeyId, plan } = parsed.data;
    const filter: Record<string, unknown> = {};

    if (taskType) filter.taskType = taskType;
    if (status) filter.status = status;
    if (plan?.trim()) filter.plan = plan.trim().toLowerCase();

    if (userId?.trim()) {
      if (!mongoose.Types.ObjectId.isValid(userId.trim())) {
        return sendError(reply, "Invalid user id.", 400, "INVALID_USER_ID");
      }
      filter.userId = new mongoose.Types.ObjectId(userId.trim());
    } else if (userEmail?.trim()) {
      const emailQ = userEmail.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const users = await UserModel.find({ email: { $regex: emailQ, $options: "i" } })
        .select("_id")
        .limit(50)
        .lean();
      if (users.length === 0) {
        return sendSuccess(reply, { page, limit, total: 0, jobs: [] });
      }
      filter.userId = { $in: users.map((u) => u._id) };
    }

    if (apiKeyId?.trim()) {
      if (!mongoose.Types.ObjectId.isValid(apiKeyId.trim())) {
        return sendError(reply, "Invalid api key id.", 400, "INVALID_API_KEY_ID");
      }
      filter.apiKeyId = new mongoose.Types.ObjectId(apiKeyId.trim());
    }

    const skip = (page - 1) * limit;
    const [total, docs] = await Promise.all([
      ChatJobModel.countDocuments(filter),
      ChatJobModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const userIds = [...new Set(docs.map((d) => String(d.userId)))];
    const users = await UserModel.find({
      _id: { $in: userIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) },
    })
      .select("_id email")
      .lean();
    const emailByUserId = new Map(users.map((u) => [String(u._id), u.email]));

    return sendSuccess(reply, {
      page,
      limit,
      total,
      jobs: docs.map((doc) =>
        toAdminChatJobSummary(doc, emailByUserId.get(String(doc.userId)) ?? null),
      ),
    });
  });

  fastify.get("/api/v1/admin/chat-jobs/:id", { preHandler: requireBearerAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return sendError(reply, "Invalid job id.", 400, "INVALID_PARAMS");
    const id = params.data.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return sendError(reply, "Invalid job id.", 400, "INVALID_JOB_ID");

    const doc = await ChatJobModel.findById(id).lean();
    if (!doc) return sendError(reply, "Job not found.", 404, "JOB_NOT_FOUND");

    const user = await UserModel.findById(doc.userId).select("email").lean();
    return sendSuccess(reply, { job: toAdminChatJob(doc, user?.email ?? null) });
  });
}
