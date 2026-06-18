import { z } from "zod";

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Slug must start with a letter or digit and use lowercase letters, digits, _, -.");

export const planCreateBodySchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).optional().default(""),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.number().int().min(0).optional().default(0),
  isDefault: z.boolean().optional().default(false),
  isPriority: z.boolean().optional().default(false),
  rateLimitPerMinute: z.number().int().min(0).max(1_000_000),
  maxCharacterPerMessage: z.number().int().min(1).max(1_000_000),
  maxChatInFlight: z.number().int().min(0).max(10_000),
  maxApiKeys: z.number().int().min(0),
  maxPdfUpload: z.number().int().min(0),
  maxPdfMb: z.number().int().min(1).max(512),
  analyticsRetentionDays: z.number().int().min(0).max(3650),
  isAutoEmbed: z.boolean().optional().default(false),
  embedBadgeCustomizable: z.boolean().optional().default(false),
  ragAnalyticsEnabled: z.boolean().optional().default(false),
  priceLabel: z.string().trim().max(64).nullable().optional(),
  priceNote: z.string().trim().max(64).nullable().optional(),
});

export const planPatchBodySchema = planCreateBodySchema
  .omit({ slug: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });

export type PlanCreateBody = z.infer<typeof planCreateBodySchema>;
export type PlanPatchBody = z.infer<typeof planPatchBodySchema>;
