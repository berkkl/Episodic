/** One transactional counter for all paid Ask calls in this deployment. */
export const ASK_DAILY_LIMIT = 100;
const GLOBAL_DAILY_LIMIT = 300;
const GLOBAL_MINUTE_LIMIT = 20;
const USER_INTERVAL_MS = 10_000;

type Counter = { day: string; total: number; minute: number; burst: number; users: Record<string, { used: number; last: number }> };

export class EpisodicQuota {
  private state: DurableObjectState;
  constructor(state: DurableObjectState) { this.state = state; }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
    const { user } = await request.json() as { user?: unknown };
    if (typeof user !== "string" || !/^[a-z0-9_]{3,20}$/.test(user)) return Response.json({ error: "user" }, { status: 400 });
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const minute = Math.floor(now / 60_000);
    return this.state.storage.transaction(async (tx) => {
      const saved = await tx.get<Counter>("counter");
      const c: Counter = saved?.day === day ? saved : { day, total: 0, minute, burst: 0, users: {} };
      if (c.minute !== minute) { c.minute = minute; c.burst = 0; }
      const userKey = `u:${user}`;
      const u = c.users[userKey] || { used: 0, last: 0 };
      if (u.used >= ASK_DAILY_LIMIT) {
        return Response.json({ error: "quota", limit: ASK_DAILY_LIMIT }, { status: 429 });
      }
      if (c.total >= GLOBAL_DAILY_LIMIT) return Response.json({ error: "global_quota" }, { status: 429 });
      if (now - u.last < USER_INTERVAL_MS || c.burst >= GLOBAL_MINUTE_LIMIT) {
        return Response.json({ error: "rate" }, { status: 429, headers: { "Retry-After": "60" } });
      }
      c.total++; c.burst++; c.users[userKey] = { used: u.used + 1, last: now };
      await tx.put("counter", c);
      return Response.json({ left: ASK_DAILY_LIMIT - u.used - 1 });
    });
  }
}

export async function reserveAsk(namespace: DurableObjectNamespace | undefined, user: string): Promise<Response> {
  if (!namespace) return Response.json({ error: "unconfigured" }, { status: 503 });
  try {
    return await namespace.get(namespace.idFromName("ask-budget-v1")).fetch("https://quota.internal/reserve", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user }),
    });
  } catch {
    // A failed counter must never turn into an unmetered paid call.
    return Response.json({ error: "busy" }, { status: 503 });
  }
}
