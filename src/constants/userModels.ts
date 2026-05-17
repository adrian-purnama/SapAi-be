export const PRICING_TIERS = ["free", "pro", "scale"] as const;

export type PricingTier = (typeof PRICING_TIERS)[number];

export const DATA_SUMMARY_BY_TIER = {
  free: "1d",
  pro: "3mo",
  scale: "1y",
} as const;