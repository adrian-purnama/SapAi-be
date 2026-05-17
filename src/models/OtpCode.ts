import mongoose, { type InferSchemaType, type Model } from "mongoose";

export type OtpPurpose = "registration" | "password_reset";

const otpCodeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    purpose: {
      type: String,
      required: true,
      enum: ["registration", "password_reset"],
      default: "registration",
      index: true,
    },
    codeHash: { type: String, required: true },
    /** When this instant passes, MongoDB TTL removes the document (`expires: 0` = delete at expiresAt). */
    expiresAt: { type: Date, required: true, expires: 0 },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

otpCodeSchema.index({ email: 1, purpose: 1 }, { unique: true });

export type OtpCodeLean = InferSchemaType<typeof otpCodeSchema>;

export const OtpCodeModel: Model<OtpCodeLean> =
  mongoose.models.OtpCode || mongoose.model<OtpCodeLean>("OtpCode", otpCodeSchema);

