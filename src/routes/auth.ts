import type { FastifyInstance } from "fastify";
import { z } from "zod";
import mongoose from "mongoose";

import { enforceLoginRateLimit, enforceOtpSendRateLimit, enforceOtpVerifyRateLimit } from "../auth/authRateLimit.js";
import { requireBearerUser } from "../auth/requireBearerUser.js";
import { AppConfigModel } from "../models/AppConfig.js";
import { OtpCodeModel } from "../models/OtpCode.js";
import { UserModel } from "../models/User.js";
import { sendPasswordResetEmail, sendOtpEmail } from "../services/brevoService.js";
import { signAuthToken } from "../services/jwtService.js";
import { hashPassword, verifyPassword } from "../services/passwordService.js";
import { getDefaultPlanFromRegistry } from "../services/planRegistry.js";
import { upsertOtpForEmail, verifyOtpForEmail } from "../services/otpService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { isValidEmail } from "../utils/isValidEmail.js";
import { rejectPasswordIfTooLong, validatePasswordForAuth } from "../utils/passwordPolicy.js";
import { resolvePlanPublicForUser } from "../utils/planAccess.js";
import { clientErrorMessage } from "../utils/sanitizeError.js";

const GENERIC_OTP_SENT = { message: "If this email is eligible, check your inbox for a code." };

function serializeAuthUser(user: {
  _id: mongoose.Types.ObjectId;
  email: string;
  isAdmin?: boolean;
  isEmailVerified?: boolean;
  plan?: unknown;
  planExpiresAt?: Date | null;
}) {
  return {
    id: user._id.toString(),
    email: user.email,
    isAdmin: Boolean(user.isAdmin),
    isEmailVerified: Boolean(user.isEmailVerified),
    plan: resolvePlanPublicForUser({ plan: user.plan, planExpiresAt: user.planExpiresAt }),
  };
}

async function getOrCreateAppConfig() {
  return (
    (await AppConfigModel.findOne()) ??
    (await AppConfigModel.create({
      appName: "SapAi",
      openRegistration: true,
      openLogin: true,
    }))
  );
}

export async function registerAuthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/api/v1/auth/login", async (request, reply) => {
    try {
      if (!(await enforceLoginRateLimit(request, reply))) return;

      const body = z
        .object({
          email: z.string().transform((v) => v.trim().toLowerCase()),
          password: z.string(),
        })
        .safeParse(request.body);

      if (!body.success) {
        return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");
      }

      const { email, password } = body.data;
      if (!isValidEmail(email)) return sendError(reply, "Invalid email address.", 400, "INVALID_EMAIL");
      const tooLong = rejectPasswordIfTooLong(password);
      if (tooLong) return sendError(reply, tooLong, 400, "PASSWORD_TOO_LONG");
      if (!password) return sendError(reply, "Password is required.", 400, "PASSWORD_REQUIRED");
      if (mongoose.connection.readyState !== 1) {
        return sendError(reply, "Service temporarily unavailable.", 503, "MONGO_NOT_READY");
      }

      const appConfig = await getOrCreateAppConfig();
      if (!appConfig.openLogin) {
        return sendError(reply, "Login is currently closed.", 403, "LOGIN_CLOSED");
      }

      const user = await UserModel.findOne({ email });
      if (!user) return sendError(reply, "Invalid credentials.", 401, "INVALID_CREDENTIALS");

      const verified = await verifyPassword(password, user.passwordHash);
      if (!verified.ok) return sendError(reply, "Invalid credentials.", 401, "INVALID_CREDENTIALS");
      if (verified.needsUpgrade) {
        user.passwordHash = await hashPassword(password);
        await user.save();
      }
      if (!user.isEmailVerified) return sendError(reply, "Email is not verified.", 403, "EMAIL_NOT_VERIFIED");
      if (user.isBlocked) return sendError(reply, "Account is blocked.", 403, "USER_BLOCKED");

      const token = signAuthToken({
        sub: user._id.toString(),
        email: user.email,
        isAdmin: Boolean(user.isAdmin),
        tokenVersion: user.tokenVersion ?? 0,
      });

      return sendSuccess(
        reply,
        {
          token,
          user: serializeAuthUser(user),
        },
        200,
      );
    } catch (err) {
      request.log.error({ err }, "login failed");
      return sendError(reply, clientErrorMessage(err, "Login failed."), 500, "LOGIN_FAILED");
    }
  });

  fastify.post("/api/v1/auth/request-otp", async (request, reply) => {
    try {
      const body = z
        .object({ email: z.string().transform((v) => v.trim().toLowerCase()) })
        .safeParse(request.body);
      if (!body.success) return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");
      const { email } = body.data;
      if (!isValidEmail(email)) return sendError(reply, "Invalid email address.", 400, "INVALID_EMAIL");
      if (!(await enforceOtpSendRateLimit(email, request, reply))) return;
      if (mongoose.connection.readyState !== 1) {
        return sendError(reply, "Service temporarily unavailable.", 503, "MONGO_NOT_READY");
      }

      const appConfig = await getOrCreateAppConfig();
      if (!appConfig.openRegistration) {
        return sendError(reply, "Registration is currently closed.", 403, "REGISTRATION_CLOSED");
      }

      const existingUser = await UserModel.findOne({ email });
      if (existingUser) {
        return sendSuccess(reply, GENERIC_OTP_SENT);
      }

      const upsert = await upsertOtpForEmail(email, "registration");
      if (!upsert.ok) {
        reply.header("Retry-After", String(upsert.retryAfterSec));
        return sendError(
          reply,
          "Please wait before requesting another code.",
          429,
          "OTP_RESEND_COOLDOWN",
        );
      }

      await sendOtpEmail(email, upsert.otp);
      return sendSuccess(reply, GENERIC_OTP_SENT);
    } catch (err) {
      request.log.error({ err }, "request-otp failed");
      return sendError(reply, clientErrorMessage(err, "Failed to request OTP."), 500, "REQUEST_OTP_FAILED");
    }
  });

  fastify.post("/api/v1/auth/register", async (request, reply) => {
    try {
      const body = z
        .object({
          email: z.string().transform((v) => v.trim().toLowerCase()),
          otp: z.string().transform((v) => v.trim()),
          password: z.string(),
          acceptedTerms: z.boolean().optional(),
        })
        .safeParse(request.body);
      if (!body.success) return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");
      const { email, otp, password, acceptedTerms } = body.data;
      if (acceptedTerms !== true) {
        return sendError(reply, "You must accept the terms and conditions to register.", 400, "TERMS_REQUIRED");
      }

      if (!isValidEmail(email)) return sendError(reply, "Invalid email address.", 400, "INVALID_EMAIL");
      if (!(await enforceOtpVerifyRateLimit(email, request, reply))) return;
      const passwordError = validatePasswordForAuth(password);
      if (passwordError) return sendError(reply, passwordError, 400, "WEAK_PASSWORD");
      if (mongoose.connection.readyState !== 1) {
        return sendError(reply, "Service temporarily unavailable.", 503, "MONGO_NOT_READY");
      }

      const appConfig = await getOrCreateAppConfig();
      if (!appConfig.openRegistration) {
        return sendError(reply, "Registration is currently closed.", 403, "REGISTRATION_CLOSED");
      }

      const existingUser = await UserModel.findOne({ email });
      if (existingUser) {
        return sendSuccess(reply, GENERIC_OTP_SENT);
      }

      const verified = await verifyOtpForEmail(email, "registration", otp);
      if (!verified.ok) {
        return sendError(reply, verified.message, verified.status, verified.code);
      }

      const passwordHash = await hashPassword(password);
      const userCount = await UserModel.countDocuments();
      const defaultPlan = getDefaultPlanFromRegistry();
      const createdUser = await UserModel.create({
        email,
        passwordHash,
        isAdmin: userCount === 0,
        isEmailVerified: true,
        termsAcceptedAt: new Date(),
        plan: defaultPlan ? new mongoose.Types.ObjectId(defaultPlan.id) : null,
        tokenVersion: 0,
      });

      await OtpCodeModel.deleteOne({ _id: verified.otpDocId });

      return sendSuccess(
        reply,
        {
          id: createdUser._id.toString(),
          email: createdUser.email,
          isAdmin: Boolean(createdUser.isAdmin),
          isEmailVerified: Boolean(createdUser.isEmailVerified),
        },
        201,
      );
    } catch (err) {
      request.log.error({ err }, "register failed");
      return sendError(reply, clientErrorMessage(err, "Registration failed."), 500, "REGISTER_FAILED");
    }
  });

  fastify.post("/api/v1/auth/forgot-password", async (request, reply) => {
    try {
      const body = z
        .object({ email: z.string().transform((v) => v.trim().toLowerCase()) })
        .safeParse(request.body);
      if (!body.success) return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");
      const { email } = body.data;
      if (!isValidEmail(email)) return sendError(reply, "Invalid email address.", 400, "INVALID_EMAIL");
      if (!(await enforceOtpSendRateLimit(email, request, reply))) return;
      if (mongoose.connection.readyState !== 1) {
        return sendError(reply, "Service temporarily unavailable.", 503, "MONGO_NOT_READY");
      }

      const user = await UserModel.findOne({ email });
      if (!user) {
        return sendSuccess(reply, GENERIC_OTP_SENT);
      }

      const upsert = await upsertOtpForEmail(email, "password_reset");
      if (!upsert.ok) {
        reply.header("Retry-After", String(upsert.retryAfterSec));
        return sendError(
          reply,
          "Please wait before requesting another code.",
          429,
          "OTP_RESEND_COOLDOWN",
        );
      }

      await sendPasswordResetEmail(email, upsert.otp);
      return sendSuccess(reply, GENERIC_OTP_SENT);
    } catch (err) {
      request.log.error({ err }, "forgot-password failed");
      return sendError(reply, clientErrorMessage(err, "Failed to request password reset."), 500, "FORGOT_PASSWORD_FAILED");
    }
  });

  fastify.post("/api/v1/auth/reset-password", async (request, reply) => {
    try {
      const body = z
        .object({
          email: z.string().transform((v) => v.trim().toLowerCase()),
          otp: z.string().transform((v) => v.trim()),
          newPassword: z.string(),
        })
        .safeParse(request.body);
      if (!body.success) return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");
      const { email, otp, newPassword } = body.data;
      if (!isValidEmail(email)) return sendError(reply, "Invalid email address.", 400, "INVALID_EMAIL");
      if (!(await enforceOtpVerifyRateLimit(email, request, reply))) return;
      const passwordError = validatePasswordForAuth(newPassword);
      if (passwordError) return sendError(reply, passwordError, 400, "WEAK_PASSWORD");
      if (mongoose.connection.readyState !== 1) {
        return sendError(reply, "Service temporarily unavailable.", 503, "MONGO_NOT_READY");
      }

      const verified = await verifyOtpForEmail(email, "password_reset", otp);
      if (!verified.ok) {
        return sendError(reply, verified.message, verified.status, verified.code);
      }

      const user = await UserModel.findOne({ email });
      if (!user) {
        await OtpCodeModel.deleteOne({ _id: verified.otpDocId });
        return sendSuccess(reply, { message: "Password updated." });
      }

      user.passwordHash = await hashPassword(newPassword);
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      await user.save();
      await OtpCodeModel.deleteOne({ _id: verified.otpDocId });

      return sendSuccess(reply, { message: "Password updated." });
    } catch (err) {
      request.log.error({ err }, "reset-password failed");
      return sendError(reply, clientErrorMessage(err, "Failed to reset password."), 500, "RESET_PASSWORD_FAILED");
    }
  });

  fastify.get(
    "/api/v1/auth/me",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      const user = request.bearerUser!;
      return sendSuccess(reply, serializeAuthUser(user));
    },
  );

  fastify.post(
    "/api/v1/auth/change-password",
    { preHandler: requireBearerUser },
    async (request, reply) => {
      try {
        const user = request.bearerUser!;
        const body = z
          .object({
            currentPassword: z.string(),
            newPassword: z.string(),
          })
          .safeParse(request.body);
        if (!body.success) return sendError(reply, "Invalid request body.", 400, "INVALID_BODY");

        const { currentPassword, newPassword } = body.data;
        if (!currentPassword) return sendError(reply, "Current password is required.", 400, "PASSWORD_REQUIRED");
        const tooLong = rejectPasswordIfTooLong(currentPassword) ?? rejectPasswordIfTooLong(newPassword);
        if (tooLong) return sendError(reply, tooLong, 400, "PASSWORD_TOO_LONG");
        const passwordError = validatePasswordForAuth(newPassword);
        if (passwordError) return sendError(reply, passwordError, 400, "WEAK_PASSWORD");

        const verified = await verifyPassword(currentPassword, user.passwordHash);
        if (!verified.ok) return sendError(reply, "Invalid current password.", 401, "INVALID_CREDENTIALS");

        user.passwordHash = await hashPassword(newPassword);
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        await user.save();
        return sendSuccess(reply, { message: "Password updated." });
      } catch (err) {
        request.log.error({ err }, "change-password failed");
        return sendError(reply, clientErrorMessage(err, "Failed to change password."), 500, "CHANGE_PASSWORD_FAILED");
      }
    },
  );

  fastify.post("/api/v1/auth/logout", async (_request, reply) => {
    return sendSuccess(reply, { message: "Logged out." });
  });
}
