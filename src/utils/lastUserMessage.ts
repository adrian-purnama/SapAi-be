export type ChatMessageLike = { role?: string; content?: string };

/** Last user message content from chat job `input` (same semantics as dashboard extraction). */
export function lastUserMessageContent(input: unknown): string | null {
  const messages = Array.isArray(input) ? (input as ChatMessageLike[]) : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  return typeof lastUser?.content === "string" && lastUser.content.trim().length > 0
    ? lastUser.content.trim()
    : null;
}

/** Mongo aggregation expression for last user `content` in `input` order. */
export const LAST_USER_CONTENT_FROM_INPUT: Record<string, unknown> = {
  $let: {
    vars: {
      userMsgs: {
        $filter: {
          input: { $ifNull: ["$input", []] },
          as: "m",
          cond: { $eq: ["$$m.role", "user"] },
        },
      },
    },
    in: {
      $let: {
        vars: {
          n: { $size: "$$userMsgs" },
        },
        in: {
          $cond: [
            { $gt: ["$$n", 0] },
            {
              $let: {
                vars: { last: { $arrayElemAt: ["$$userMsgs", { $subtract: ["$$n", 1] }] } },
                in: { $ifNull: ["$$last.content", ""] },
              },
            },
            "",
          ],
        },
      },
    },
  },
};
