import mongoose from "mongoose";

import { ApiKeyModel } from "../models/ApiKey.js";

export type OwnedApiKeyGate =
  | { ok: true; apiKeyOid: mongoose.Types.ObjectId }
  | { ok: false; error: string; status: 400 | 403 | 404 };

/**
 * Bearer-dashboard guard: key must belong to user, not revoked, and not plan-disabled.
 */
export async function requireActiveOwnedApiKey(
  userId: mongoose.Types.ObjectId,
  apiKeyId: string,
): Promise<OwnedApiKeyGate> {
  const id = apiKeyId.trim();
  if (!mongoose.isValidObjectId(id)) {
    return { ok: false, error: "Invalid key id.", status: 400 };
  }

  const key = await ApiKeyModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    userId,
    revokedAt: null,
  })
    .select("isDisabled")
    .lean();

  if (!key) {
    return { ok: false, error: "API key not found.", status: 404 };
  }

  if (key.isDisabled) {
    return {
      ok: false,
      error: "This API key is disabled for your current plan. Use your primary key or upgrade.",
      status: 403,
    };
  }

  return { ok: true, apiKeyOid: new mongoose.Types.ObjectId(id) };
}
