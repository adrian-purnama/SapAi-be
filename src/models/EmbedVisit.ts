import mongoose, { type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

const embedVisitSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    apiKeyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    /** Raw client IP (IPv4 or IPv6) as resolved from request headers. */
    ip: { type: String, required: true, trim: true, maxlength: 64 },
    location: { type: String, default: null, trim: true, maxlength: 64 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    messageCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: false, collection: "embedvisits" },
);

embedVisitSchema.index({ apiKeyId: 1, ip: 1 }, { unique: true });
embedVisitSchema.index({ apiKeyId: 1, lastSeenAt: -1 });

export type EmbedVisitLean = InferSchemaType<typeof embedVisitSchema>;
export type EmbedVisitDocument = HydratedDocument<EmbedVisitLean>;

export const EmbedVisitModel: Model<EmbedVisitLean> =
  mongoose.models.EmbedVisit || mongoose.model<EmbedVisitLean>("EmbedVisit", embedVisitSchema);
