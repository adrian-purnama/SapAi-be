import mongoose, { type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

export const CHAT_SESSION_STATUS_VALUES = ["active", "ended"] as const;

const chatSessionMessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const chatSessionSchema = new mongoose.Schema(
  {
    apiKeyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    status: {
      type: String,
      enum: CHAT_SESSION_STATUS_VALUES,
      default: "active",
      required: true,
    },
    messages: { type: [chatSessionMessageSchema], default: [] },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "chatsessions" },
);

chatSessionSchema.index({ apiKeyId: 1, status: 1, expiresAt: -1 });
chatSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type ChatSessionLean = InferSchemaType<typeof chatSessionSchema>;
export type ChatSessionDocument = HydratedDocument<ChatSessionLean>;
export type ChatSessionMessage = { role: "user" | "assistant"; content: string };

export const ChatSessionModel: Model<ChatSessionLean> =
  mongoose.models.ChatSession || mongoose.model<ChatSessionLean>("ChatSession", chatSessionSchema);
