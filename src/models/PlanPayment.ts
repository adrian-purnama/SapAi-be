import mongoose, { type InferSchemaType, type Model } from "mongoose";

const planPaymentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planSlug: { type: String, required: true, trim: true, lowercase: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    isPaid: { type: Boolean, default: false, index: true },
    transactionToken: { type: String, default: null, trim: true },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "plan_payments" },
);

planPaymentSchema.index({ userId: 1, createdAt: -1 });

export type PlanPaymentLean = InferSchemaType<typeof planPaymentSchema>;

export const PlanPaymentModel: Model<PlanPaymentLean> =
  mongoose.models.PlanPayment || mongoose.model<PlanPaymentLean>("PlanPayment", planPaymentSchema);
