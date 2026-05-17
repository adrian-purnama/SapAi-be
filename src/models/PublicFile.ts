import mongoose, { type InferSchemaType, type Model } from "mongoose";

/** Metadata for blobs stored in the GridFS bucket `publicFiles`. */
const publicFileSchema = new mongoose.Schema(
  {
    gridFsFileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    },
    originalFilename: { type: String, required: true },
    contentType: { type: String, required: true },
    length: { type: Number, required: true },
  },
  { timestamps: true },
);

export type PublicFileLean = InferSchemaType<typeof publicFileSchema>;

export const PublicFileModel: Model<PublicFileLean> =
  mongoose.models.PublicFile || mongoose.model<PublicFileLean>("PublicFile", publicFileSchema);

