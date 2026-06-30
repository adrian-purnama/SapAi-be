import mongoose, { type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

export const MAX_MCP_URL_LEN = 2048;
export const MAX_MCP_HEADER_KEYS = 20;
export const MAX_MCP_HEADER_VALUE_LEN = 512;
export const MAX_MCP_BODY_BYTES = 4096;

const apiKeyMcpSettingsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    apiKeyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApiKey",
      required: true,
      unique: true,
      index: true,
    },
    enabled: { type: Boolean, default: false, index: true },
    mcpUrl: { type: String, default: "", trim: true, maxlength: MAX_MCP_URL_LEN },
    headers: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    body: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true, collection: "apikeymcpsettings" },
);

export type ApiKeyMcpSettingsLean = InferSchemaType<typeof apiKeyMcpSettingsSchema>;
export type ApiKeyMcpSettingsDocument = HydratedDocument<ApiKeyMcpSettingsLean>;

export const ApiKeyMcpSettingsModel: Model<ApiKeyMcpSettingsLean> =
  mongoose.models.ApiKeyMcpSettings ||
  mongoose.model<ApiKeyMcpSettingsLean>("ApiKeyMcpSettings", apiKeyMcpSettingsSchema);
