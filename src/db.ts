import mongoose from "mongoose";

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDb(uri: string): Promise<void> {
  if (!uri) {
    throw new Error("MONGODB_URI is not set");
  }
  if (mongoose.connection.readyState === 1) {
    return;
  }
  if (!connecting) {
    connecting = mongoose.connect(uri);
  }
  await connecting;
  connecting = null;
}

export async function pingDb(): Promise<void> {
  await mongoose.connection.db?.admin().command({ ping: 1 });
}
