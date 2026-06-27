import type { PlanSnapshot } from "../services/planRegistry.js";

export type PricingPlanPublic = {
  slug: string;
  name: string;
  description: string;
  priceLabel: string | null;
  priceNote: string | null;
  accentColor: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isPayable: boolean;
};

export type PricingCompareRow = {
  label: string;
  values: string[];
};

export type PricingPublicPayload = {
  plans: PricingPlanPublic[];
  compareRows: PricingCompareRow[];
  cardBullets: string[][];
};

const EMPTY_CELL = " ";

function hasChatAndRag(taskAccess: Record<string, string[]>): boolean {
  const chat = taskAccess.chat;
  const rag = taskAccess.rag;
  return Boolean(chat?.length && rag?.length);
}

function formatRateLimit(n: number): string {
  return n === 0 ? "Unlimited" : String(n);
}

function formatRetentionLabel(days: number): string {
  if (days <= 0) return "Today only";
  if (days === 1) return "1 day";
  if (days % 30 === 0) {
    const months = days / 30;
    return months === 1 ? "1 month" : `${months} months`;
  }
  return `${days} days`;
}

function formatEmbedBadge(plan: PlanSnapshot): string {
  if (!plan.isAutoEmbed) return EMPTY_CELL;
  return plan.embedBadgeCustomizable ? "Fully customizable" : "Fixed SapAi badge";
}

function formatEmbedWidget(plan: PlanSnapshot): string {
  return plan.isAutoEmbed ? "Included" : EMPTY_CELL;
}

type CompareDef = {
  label: string;
  value: (plan: PlanSnapshot) => string;
  /** Skip when building card bullets (static/redundant rows). */
  skipBullet?: boolean;
  /** Format as a card bullet string. */
  bullet?: (plan: PlanSnapshot, cell: string) => string | null;
};

const COMPARE_DEFS: CompareDef[] = [
  {
    label: "API keys (total)",
    value: (p) => String(p.maxApiKeys),
    bullet: (p) => `${p.maxApiKeys} API key${p.maxApiKeys === 1 ? "" : "s"}`,
  },
  {
    label: "Chat + RAG via API",
    value: (p) => (hasChatAndRag(p.taskAccess) ? "Included" : EMPTY_CELL),
    skipBullet: true,
  },
  {
    label: "Queue",
    value: () => "Unlimited",
    skipBullet: true,
  },
  {
    label: "Priority processing",
    value: (p) => (p.isPriority ? "Yes" : EMPTY_CELL),
    bullet: (p) => (p.isPriority ? "Priority processing" : null),
  },
  {
    label: "API requests / minute (per key)",
    value: (p) => formatRateLimit(p.rateLimitPerMinute),
    bullet: (p, cell) =>
      p.rateLimitPerMinute === 0
        ? "Unlimited API requests / minute"
        : `${cell} API requests / minute (per key)`,
  },
  {
    label: "Max characters per message",
    value: (p) => p.maxCharacterPerMessage.toLocaleString("en-US"),
    bullet: (p) => `${p.maxCharacterPerMessage.toLocaleString("en-US")} characters per message`,
  },
  {
    label: "Knowledge files / project",
    value: (p) => String(p.maxPdfUpload),
    bullet: (p) =>
      `${p.maxPdfUpload} Markdown (.md) file${p.maxPdfUpload === 1 ? "" : "s"} per project · ${p.maxPdfMb} MB max`,
  },
  {
    label: "File type",
    value: () => "Markdown (.md)",
    skipBullet: true,
  },
  {
    label: "Max file size",
    value: (p) => `${p.maxPdfMb} MB`,
    skipBullet: true,
  },
  {
    label: "Vector search storage",
    value: () => "Included",
    bullet: () => "Vector search storage included",
  },
  {
    label: "Usage & RAG insights",
    value: (p) => formatRetentionLabel(p.analyticsRetentionDays),
    bullet: (_p, cell) => `Usage history: ${cell}`,
  },
  {
    label: "Public embed widget",
    value: formatEmbedWidget,
    bullet: (p) => (p.isAutoEmbed ? "Public embed widget (iframe) on your site" : null),
  },
  {
    label: "Embed badge & disclaimer",
    value: formatEmbedBadge,
    bullet: (p) => {
      if (!p.isAutoEmbed) return null;
      return p.embedBadgeCustomizable
        ? "Custom embed badge & AI disclaimer"
        : "Fixed “Provided by SapAi” badge on embed";
    },
  },
];

const MAX_CARD_BULLETS = 7;

export function buildPricingPublicPayload(
  plans: PlanSnapshot[],
  resolveImageUrl: (fileId: string | null) => string | null,
): PricingPublicPayload {
  const publicPlans: PricingPlanPublic[] = plans.map((p) => ({
    slug: p.slug,
    name: p.name,
    description: p.description,
    priceLabel: p.priceLabel,
    priceNote: p.priceNote,
    accentColor: p.accentColor,
    imageUrl: resolveImageUrl(p.imageFileId),
    sortOrder: p.sortOrder,
    isPayable: Boolean(p.midtrans.grossAmount && p.midtrans.grossAmount > 0),
  }));

  const compareRows: PricingCompareRow[] = COMPARE_DEFS.map((def) => ({
    label: def.label,
    values: plans.map((p) => def.value(p)),
  }));

  const cardBullets: string[][] = plans.map((plan) => {
    const bullets: string[] = [];
    for (const def of COMPARE_DEFS) {
      if (def.skipBullet || bullets.length >= MAX_CARD_BULLETS) continue;
      const cell = def.value(plan);
      if (cell === EMPTY_CELL) continue;
      const text = def.bullet ? def.bullet(plan, cell) : null;
      if (text) bullets.push(text);
    }
    return bullets;
  });

  return { plans: publicPlans, compareRows, cardBullets };
}

export function filterPricingPlans(plans: readonly PlanSnapshot[]): PlanSnapshot[] {
  return plans.filter((p) => p.isActive && p.showOnPricingPage);
}

// ponytail: assert self-check
function _pricingPublicSelfCheck(): void {
  const sample: PlanSnapshot = {
    id: "x",
    slug: "pro",
    name: "Pro",
    description: "",
    isActive: true,
    sortOrder: 1,
    isDefault: false,
    isPriority: true,
    rateLimitPerMinute: 120,
    maxCharacterPerMessage: 3000,
    maxChatInFlight: 5,
    maxApiKeys: 3,
    maxPdfUpload: 5,
    maxPdfMb: 10,
    maxOcrMb: 10,
    analyticsRetentionDays: 90,
    isAutoEmbed: true,
    embedBadgeCustomizable: false,
    ragAnalyticsEnabled: true,
    priceLabel: "150k",
    priceNote: "per month",
    showOnPricingPage: true,
    imageFileId: null,
    accentColor: "#7c3aed",
    midtrans: { grossAmount: 150_000 },
    taskAccess: { chat: ["default"], rag: ["default"] },
    createdAt: null,
    updatedAt: null,
  };

  const payload = buildPricingPublicPayload([sample], () => null);
  console.assert(payload.compareRows.length === COMPARE_DEFS.length, "compare row count");
  console.assert(payload.cardBullets[0]!.length > 0, "card bullets");
  const priorityRow = payload.compareRows.find((r) => r.label === "Priority processing");
  console.assert(priorityRow?.values[0] === "Yes", "priority yes");
  console.assert(payload.plans[0]?.isPayable === true, "isPayable");
}
if (process.argv[1]?.includes("planPricingPublic")) _pricingPublicSelfCheck();
