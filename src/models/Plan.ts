import mongoose, { type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

import { DEFAULT_TASK_ACCESS } from "../constants/taskCatalog.js";

/**
 * Admin-configurable subscription plan. Intended to replace hardcoded tier constants
 * for limits, queue behavior, retention, and feature flags on users (`User.plan` → `slug`).
 */
const planSchema = new mongoose.Schema(
  {
    /** Stable id stored on users and jobs (e.g. `free`, `pro`, `scale`). */
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 32,
      match: /^[a-z0-9][a-z0-9_-]*$/,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: "", trim: true, maxlength: 2000 },

    isActive: { type: Boolean, default: true },
    /** Lower sorts first in admin / pricing lists. */
    sortOrder: { type: Number, default: 0, min: 0 },
    /** Default plan assigned to new accounts (at most one should be true in production). */
    isDefault: { type: Boolean, default: false },

    /** When true, account may use priority queue execution (vs best-effort only). */
    isPriority: { type: Boolean, default: false },

    /** Default API requests per minute per key (`0` = unlimited). */
    rateLimitPerMinute: { type: Number, required: true, min: 0, max: 1_000_000, default: 60 },
    /** Max characters per chat message in `input[].content`. */
    maxCharacterPerMessage: { type: Number, required: true, min: 1, max: 1_000_000, default: 2000 },
    /** Max in-flight chat jobs per user (`pending` + `queued` + `running`). `0` = unlimited. */
    maxChatInFlight: { type: Number, required: true, min: 0, max: 10_000, default: 5 },

    maxApiKeys: { type: Number, required: true, min: 0 },
    /** Max RAG PDF files per API key / project. */
    maxPdfUpload: { type: Number, required: true, min: 0 },
    /** Max size per PDF file, in megabytes. */
    maxPdfMb: { type: Number, required: true, min: 1, max: 512 },
    /** Max decoded OCR image size per request, in megabytes. */
    maxOcrMb: { type: Number, required: true, min: 1, max: 512, default: 10 },

    /** How far back (calendar days) the plan may view dashboard / RAG analytics. `0` = today (UTC) only. */
    analyticsRetentionDays: { type: Number, required: true, min: 0, max: 3650 },

    isAutoEmbed: { type: Boolean, default: false },
    /** When true (Scale), embed app badge can be hidden or relabeled; Pro keeps fixed badge. */
    embedBadgeCustomizable: { type: Boolean, default: false },
    ragAnalyticsEnabled: { type: Boolean, default: false },

    /** Optional display pricing (minor units or arbitrary; interpret in admin UI). */
    priceLabel: { type: String, default: null, trim: true, maxlength: 64 },
    priceNote: { type: String, default: null, trim: true, maxlength: 64 },

    /** When true, plan appears on the public `/pricing` page. */
    showOnPricingPage: { type: Boolean, default: false },
    /** GridFS public file id for pricing card image (`publicFiles` bucket). */
    imageFileId: { type: String, default: null, trim: true },
    /** Hex accent for pricing card border/CTA (e.g. `#7c3aed`). */
    accentColor: { type: String, default: null, trim: true, maxlength: 9 },

    /** Midtrans Snap/charge settings for this plan. */
    midtrans: {
      type: new mongoose.Schema(
        {
          /** Whole IDR amount for Midtrans `gross_amount` (e.g. 150000). null = not payable. */
          grossAmount: { type: Number, default: null, min: 0 },
        },
        { _id: false },
      ),
      default: () => ({ grossAmount: null }),
    },

    /** Per-task allowed public model labels (keys from task catalog: chat, rag, translate, ocr). */
    taskAccess: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ ...DEFAULT_TASK_ACCESS }),
    },
  },
  { timestamps: true, collection: "plans" },
);

planSchema.index({ isActive: 1, sortOrder: 1 });
planSchema.index({ isDefault: 1 });
planSchema.index({ showOnPricingPage: 1, isActive: 1, sortOrder: 1 });

export type PlanLean = InferSchemaType<typeof planSchema>;
export type PlanDocument = HydratedDocument<PlanLean>;

export const PlanModel: Model<PlanLean> =
  mongoose.models.Plan || mongoose.model<PlanLean>("Plan", planSchema);
