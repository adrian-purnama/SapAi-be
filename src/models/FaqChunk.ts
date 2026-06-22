import mongoose, { type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

/** Text chunks derived from FAQ uploads for retrieval / embedding. Collection `faqchunks`. */
const faqChunkSchema = new mongoose.Schema(
  {
    faqDocumentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FaqDocument",
      required: true,
      index: true,
    },
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
    chunkIndex: { type: Number, required: true, min: 0 },
    text: { type: String, required: true },
    isProcessed: { type: Boolean, default: false },
    /** Ollama-resolved embedding model id from `POST /api/embed` (`model` field); includes tag/digest. Set when embedding succeeds. */
    embeddingModel: { type: String, default: null },
  },
  { timestamps: true, collection: "faqchunks" },
);

faqChunkSchema.index({ faqDocumentId: 1, chunkIndex: 1 }, { unique: true });
faqChunkSchema.index({ userId: 1, faqDocumentId: 1 });
faqChunkSchema.index({ text: "text" });

export type FaqChunkLean = InferSchemaType<typeof faqChunkSchema>;
export type FaqChunkDocument = HydratedDocument<FaqChunkLean>;

export const FaqChunkModel: Model<FaqChunkLean> =
  mongoose.models.FaqChunk || mongoose.model<FaqChunkLean>("FaqChunk", faqChunkSchema);

