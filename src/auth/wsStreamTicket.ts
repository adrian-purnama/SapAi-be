import crypto from "node:crypto";

const TTL_MS = Number(process.env.WS_STREAM_TICKET_TTL_MS ?? 60_000);

type TicketPayload = {
  jobId: string;
  apiKey?: string;
  embedToken?: string;
  expiresAt: number;
};

const tickets = new Map<string, TicketPayload>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of tickets) {
    if (v.expiresAt <= now) tickets.delete(k);
  }
}

export function issueWsStreamTicket(payload: {
  jobId: string;
  apiKey?: string;
  embedToken?: string;
}): { ticket: string; expiresInSec: number } {
  prune();
  const ticket = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + TTL_MS;
  tickets.set(ticket, {
    jobId: payload.jobId,
    apiKey: payload.apiKey?.trim() || undefined,
    embedToken: payload.embedToken?.trim() || undefined,
    expiresAt,
  });
  return { ticket, expiresInSec: Math.ceil(TTL_MS / 1000) };
}

export function consumeWsStreamTicket(
  ticket: string,
  jobId: string,
): { apiKey?: string; embedToken?: string } | null {
  prune();
  const key = ticket.trim();
  if (!key) return null;
  const entry = tickets.get(key);
  if (!entry || entry.jobId !== jobId || entry.expiresAt <= Date.now()) {
    tickets.delete(key);
    return null;
  }
  tickets.delete(key);
  return { apiKey: entry.apiKey, embedToken: entry.embedToken };
}
