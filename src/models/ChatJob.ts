import mongoose, { type HydratedDocument, type InferSchemaType, type Model } from "mongoose";
import { CHAT_TASK_TYPES } from "../schemas/chatJobBody.js";
import { FAQ_ANSWERABLE_VALUES, FAQ_INTENT_VALUES } from "../constants/faqDocument.js";


export const CHAT_JOB_STATUS_VALUES = [
  "pending",
  "queued",
  "running",
  "completed_partial",
  "completed_full",
  "failed",
  "cancelled",
] as const;


const chatMessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["system", "user", "assistant", "tool"],
      required: true,
    },
    content: { type: String, required: true },
  },
  { _id: false },
);

const chatJobResultSchema = new mongoose.Schema(
  {
    text: { type: String, default: null },
    json: { type: mongoose.Schema.Types.Mixed, default: null },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
  },
  { _id: false },
);

const chatJobErrorSchema = new mongoose.Schema(
  {
    message: { type: String, default: null },
    code: { type: String, default: null },
  },
  { _id: false },
);

const chatJobRagAnalysisSchema = new mongoose.Schema(
  {
    category: { type: String, default: null },
    answerable: { type: String, enum: FAQ_ANSWERABLE_VALUES, default: null },
    intent: { type: String, enum: FAQ_INTENT_VALUES, default: null },
  },
  { _id: false },
);


const chatJobSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** Plan slug at job creation (from plan registry). */
    plan: { type: String, required: true, trim: true, lowercase: true, maxlength: 32, index: true },
    apiKeyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    taskType: { type: String, enum: CHAT_TASK_TYPES, required: true, index: true },
    status: {
      type: String,
      enum: CHAT_JOB_STATUS_VALUES,
      default: "pending",
      index: true,
    },
    model: { type: String, required: true },
    maxTokens: { type: Number, default: 500 },
    input: { type: [chatMessageSchema], default: [] },
    result: { type: chatJobResultSchema, default: null },
    ragAnalysis: { type: chatJobRagAnalysisSchema, default: null },
    error: { type: chatJobErrorSchema, default: null },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "chatjobs" },
);

chatJobSchema.index({ userId: 1, apiKeyId: 1, status: 1, createdAt: -1 });
chatJobSchema.index({ status: 1, startedAt: 1 });
chatJobSchema.index({ apiKeyId: 1, taskType: 1, status: 1, createdAt: -1 });
chatJobSchema.index({ apiKeyId: 1, taskType: 1, "ragAnalysis.answerable": 1, createdAt: -1 });
chatJobSchema.index({ apiKeyId: 1, taskType: 1, "ragAnalysis.intent": 1, createdAt: -1 });
chatJobSchema.index({ apiKeyId: 1, taskType: 1, "ragAnalysis.category": 1, createdAt: -1 });

export type ChatJobLean = InferSchemaType<typeof chatJobSchema>;
export type ChatJobDocument = HydratedDocument<ChatJobLean>;

export const ChatJobModel: Model<ChatJobLean> =
  mongoose.models.ChatJob || mongoose.model<ChatJobLean>("ChatJob", chatJobSchema);
