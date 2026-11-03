import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { oversees } from "./access";
import { currentPeriod, goalsOf } from "./goals";
import { skillsOf } from "./settings";

/** The Performance tab on a profile: skills for everyone; current goals (private ones only for managers); released ratings for the person and their managers / HR. */
export async function profilePerformance(tx: Tx, actor: Actor, employeeId: string) {
  const self = employeeId === actor.employeeId;
  const manage = !self && (await oversees(tx, actor, employeeId));
  const period = await currentPeriod(tx);
  const [skills, goals] = await Promise.all([skillsOf(tx, employeeId), goalsOf(tx, actor, employeeId, period?.starts_on, period?.ends_on)]);
  const ratings = self || manage ? await tx<{ cycle: string; rating: string | null; band: string | null; published_at: Date | null }[]>`
    select c.name as cycle, coalesce(o.final_rating, o.computed_rating) as rating, o.band, o.published_at
    from review_outcomes o join review_cycles c on c.id = o.cycle_id where o.employee_id = ${employeeId} and o.released order by o.published_at desc limit 10` : [];
  return {
    self, manage, period: period?.name ?? null, skills,
    goals: goals.filter((g) => g.status !== "closed").map((g) => ({ id: g.id, title: g.title, progress: g.progress, status: g.status })),
    ratings: ratings.map((r) => ({ cycle: r.cycle, rating: r.rating == null ? null : Number(r.rating), band: r.band, published_at: r.published_at?.toISOString() ?? null })),
  };
}
