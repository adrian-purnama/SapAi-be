import type { ClientSession } from "mongodb";
import mongoose from "mongoose";
import { PublicFileModel } from "../models/PublicFile.js";
import { getGridFsBucket, toObjectId, uploadBufferToGridFs } from "../utils/gridfs.js";

export const PUBLIC_FILES_BUCKET = "publicFiles";

export type UploadPublicFileOptions = {
  originalFilename: string;
  contentType: string;
};

export type UploadPublicFileResult = {
  fileId: string;
  urlPath: string;
};

function publicFileUrlPath(fileId: string): string {
  return `/api/v1/files/${fileId}`;
}

export function getPublicFilesBucket() {
  return getGridFsBucket(PUBLIC_FILES_BUCKET);
}

export async function uploadPublicFile(
  buffer: Buffer,
  options: UploadPublicFileOptions,
  session?: ClientSession,
): Promise<UploadPublicFileResult> {
  const bucket = getPublicFilesBucket();
  const gridFsFileId = await uploadBufferToGridFs(
    bucket,
    buffer,
    options.originalFilename,
    options.contentType,
    session,
  );

  await PublicFileModel.create(
    [
      {
        gridFsFileId,
        originalFilename: options.originalFilename,
        contentType: options.contentType,
        length: buffer.length,
      },
    ],
    session ? { session } : {},
  );

  const idHex = gridFsFileId.toString();
  return { fileId: idHex, urlPath: publicFileUrlPath(idHex) };
}

export async function deletePublicFile(fileId: string, session?: ClientSession): Promise<void> {
  const _id = toObjectId(fileId, "Invalid file id.");
  const bucket = getPublicFilesBucket();

  if (session) {
    // @ts-expect-error GridFSBucket.delete supports session at runtime
    await bucket.delete(_id, { session });
  } else {
    await bucket.delete(_id);
  }

  if (session) {
    await PublicFileModel.deleteOne({ gridFsFileId: _id }).session(session);
  } else {
    await PublicFileModel.deleteOne({ gridFsFileId: _id });
  }
}

export async function updatePublicFile(
  previousFileId: string | null | undefined,
  buffer: Buffer,
  options: UploadPublicFileOptions,
): Promise<UploadPublicFileResult> {
  const session = await mongoose.startSession();
  try {
    if (previousFileId) {
      await deletePublicFile(previousFileId, session);
    }
    return await uploadPublicFile(buffer, options, session);
  } finally {
    await session.endSession();
  }
}

export type PublicFileDownload = {
  stream: NodeJS.ReadableStream;
  contentType: string;
  filename: string;
  length: number;
};

export async function getPublicFileForDownload(fileId: string): Promise<PublicFileDownload | null> {
  const _id = toObjectId(fileId, "Invalid file id.");
  const bucket = getPublicFilesBucket();
  const meta = await PublicFileModel.findOne({ gridFsFileId: _id }).lean();
  if (!meta) return null;

  const stream = bucket.openDownloadStream(_id);
  return {
    stream,
    contentType: meta.contentType,
    filename: meta.originalFilename,
    length: meta.length,
  };
}

