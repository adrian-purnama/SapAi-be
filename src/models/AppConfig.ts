import mongoose, { type InferSchemaType, type Model } from "mongoose";

const appConfigSchema = new mongoose.Schema(
  {
    appName: { type: String, default: "SapAi" },
    openRegistration: { type: Boolean, default: true },
    openLogin: { type: Boolean, default: true },
    logo: {
      fileId: { type: String, default: null },
      url: { type: String, default: null },
    },
  },
  { timestamps: true },
);

export type AppConfigLean = InferSchemaType<typeof appConfigSchema>;

export const AppConfigModel: Model<AppConfigLean> =
  mongoose.models.AppConfig || mongoose.model<AppConfigLean>("AppConfig", appConfigSchema);

