import type { ClientSession } from "mongodb";
import mongoose from "mongoose";

export function getMongoDb() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB connection is not ready.");
  return db;
}

export function toObjectId(id: string, invalidMessage = "Invalid id."): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new Error(invalidMessage);
  return new mongoose.Types.ObjectId(id);
}

export function getGridFsBucket(bucketName: string) {
  return new mongoose.mongo.GridFSBucket(getMongoDb(), { bucketName });
}

export function uploadBufferToGridFs(
  bucket: mongoose.mongo.GridFSBucket,
  buffer: Buffer,
  originalFilename: string,
  contentType: string,
  session?: ClientSession,
): Promise<mongoose.Types.ObjectId> {
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(originalFilename, {
      ...(session ? { session } : {}),
      metadata: { contentType },
    });
    uploadStream.once("finish", () => resolve(uploadStream.id as mongoose.Types.ObjectId));
    uploadStream.once("error", reject);
    uploadStream.end(buffer);
  });
}
