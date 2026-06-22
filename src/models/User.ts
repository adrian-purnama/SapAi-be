import mongoose, { type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    isEmailVerified: { type: Boolean, default: false },
    isBlocked: { type: Boolean, default: false },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null },
    /** When set, non-default assigned plans expire at this instant; null = never expires. */
    planExpiresAt: { type: Date, default: null },
    termsAcceptedAt: { type: Date },
    /** Incremented on password change; invalidates older JWTs. */
    tokenVersion: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

export type UserLean = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<UserLean>;

export const UserModel: Model<UserLean> =
  mongoose.models.User || mongoose.model<UserLean>("User", userSchema);
