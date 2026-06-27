import mongoose, { type InferSchemaType, type Model } from "mongoose";

const USER_PLAN_HISTORY_KINDS = ["assigned", "expired", "downgraded"] as const;
export type UserPlanHistoryKind = (typeof USER_PLAN_HISTORY_KINDS)[number];

const userPlanHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    kind: { type: String, required: true, enum: USER_PLAN_HISTORY_KINDS },
    planSlug: { type: String, required: true, trim: true },
    planName: { type: String, required: true, trim: true },
    planExpiresAt: { type: Date, default: null },
    toPlanSlug: { type: String, default: null, trim: true },
    toPlanName: { type: String, default: null, trim: true },
    actor: { type: String, required: true, enum: ["admin", "system"] },
    adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "user_plan_history" },
);

userPlanHistorySchema.index({ userId: 1, createdAt: -1 });

export type UserPlanHistoryLean = InferSchemaType<typeof userPlanHistorySchema>;

export const UserPlanHistoryModel: Model<UserPlanHistoryLean> =
  mongoose.models.UserPlanHistory ||
  mongoose.model<UserPlanHistoryLean>("UserPlanHistory", userPlanHistorySchema);
