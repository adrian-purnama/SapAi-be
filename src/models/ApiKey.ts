import mongoose, { type HydratedDocument, type InferSchemaType, type Model, type Types } from "mongoose";

const apiKeySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    prefix: { type: String, required: true, trim: true, index: true },
    hashedKey: { type: String, required: true, unique: true, index: true },
    ipAllowlist: { type: [String], default: [] },
    revokedAt: { type: Date, default: null, index: true },
    lastUsedAt: { type: Date, default: null, index: true },
    primaryKey: { type: Boolean, default: false },
    isDisabled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

apiKeySchema.index({ userId: 1, revokedAt: 1, createdAt: -1 });
apiKeySchema.index({ userId: 1, isDisabled: 1, revokedAt: 1 });
apiKeySchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { primaryKey: true, revokedAt: null },
  },
);

export type ApiKeyLean = InferSchemaType<typeof apiKeySchema>;
export type ApiKeyDocument = HydratedDocument<ApiKeyLean>;

export const ApiKeyModel: Model<ApiKeyLean> =
  mongoose.models.ApiKey || mongoose.model<ApiKeyLean>("ApiKey", apiKeySchema);

export type ApiKeyId = Types.ObjectId;
