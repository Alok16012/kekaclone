/**
 * Demo data for performance and compensation on the seeded tenant (called from db/seed.ts):
 * goal periods; company → department → individual OKRs with key results and check-ins (one private goal);
 * feedback given, requested and a manager's note; recurring 1:1s with a completed meeting whose open action item moved forward;
 * a skills library with people's skills; a review form; a published half-year cycle, a live quarterly cycle with peers to approve,
 * an automatic new-joiner cycle; a PIP; and a compensation cycle open for recommendations from the published ratings.
 */
import { withTenant, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn } from "@/lib/dates";
import { ensurePerformanceDefaults, saveCompetency, setMySkill } from "@/server/modules/performance/settings";
import * as goals from "@/server/modules/performance/goals";
import * as fb from "@/server/modules/performance/feedback";
import * as one from "@/server/modules/performance/one-on-ones";
import * as rv from "@/server/modules/performance/reviews";
import * as pip from "@/server/modules/performance/pip";
import * as comp from "@/server/modules/performance/compensation";

export async function seedPerformance(tenantId: string) {
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[] = []): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes: [] }] : [] };
  };
  const asha = await actor("Asha", ["*"]);
  const priya = await actor("Priya", ["employees.read", "employees.write", "performance.admin"]);
  const [rohan, arjun, meera, vikram, sneha, imran, karan, divya] = await Promise.all(["Rohan", "Arjun", "Meera", "Vikram", "Sneha", "Imran", "Karan", "Divya"].map((n) => actor(n)));
  const today = todayIn();
  const year = Number(today.slice(0, 4));
  const tx1 = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tenantId, fn);

  // ---------- defaults, periods, library ----------
  const { current, previous } = await tx1(async (tx) => {
    await tx`update roles set permissions = (select array_agg(distinct p) from unnest(permissions || ${["performance.admin"]}::text[]) p) where key = 'hr_admin'`;
    await ensurePerformanceDefaults(tx, tenantId);
    const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
    const qs = (y: number, i: number) => `${y}-${String(i * 3 + 1).padStart(2, "0")}-01`;
    const qe = (y: number, i: number) => addDaysISO(i === 3 ? `${y + 1}-01-01` : qs(y, i + 1), -1);
    const cur = await goals.savePeriod(tx, asha, null, { name: `Q${q + 1} ${year}`, startsOn: qs(year, q), endsOn: qe(year, q) });
    const pq = q === 0 ? 3 : q - 1, py = q === 0 ? year - 1 : year;
    const prev = await goals.savePeriod(tx, asha, null, { name: `Q${pq + 1} ${py}`, startsOn: qs(py, pq), endsOn: qe(py, pq) });
    for (const [name, description] of [["React", "Building web interfaces with React"], ["PostgreSQL", "Schema design and query tuning"], ["Negotiation", "Closing deals that work for both sides"], ["Excel modelling", "Financial models and reconciliations"], ["Public speaking", "Presenting to groups"]] as const)
      await saveCompetency(tx, asha, null, { kind: "skill", name, description });
    return { current: cur.id, previous: prev.id };
  });
  const skill = async (name: string) => (await tx1((tx) => tx<{ id: string }[]>`select id from competencies where name = ${name}`))[0].id;
  for (const [who, list] of [[arjun, [["React", 4], ["PostgreSQL", 3]]], [meera, [["React", 5], ["Public speaking", 2]]], [sneha, [["Negotiation", 4], ["Public speaking", 4]]], [karan, [["Excel modelling", 5]]]] as const)
    for (const [name, level] of list) { const id = await skill(name); await tx1((tx) => setMySkill(tx, who, id, level)); }

  // ---------- OKRs ----------
  const ids = await tx1(async (tx) => {
    const [eng] = await tx<{ id: string }[]>`select id from departments where name = 'Engineering'`;
    const [sales] = await tx<{ id: string }[]>`select id from departments where name = 'Sales'`;
    const due = addDaysISO(today, 50);
    const growth = await goals.createObjective(tx, asha, { level: "company", periodId: current, title: "Grow annual recurring revenue by 30%", description: "Land bigger customers and keep the ones we have.", dueDate: due,
      keyResults: [{ title: "New ARR booked (₹ lakh)", metric: "currency", start: 0, target: 300, current: 120, weight: 60 }, { title: "Gross revenue retention", metric: "percent", start: 85, target: 95, current: 89, weight: 40 }] });
    const people = await goals.createObjective(tx, asha, { level: "company", periodId: current, title: "Make Acme a place people recommend", dueDate: due,
      keyResults: [{ title: "Employee NPS", metric: "number", start: 10, target: 40, current: 22, weight: 50 }, { title: "Regretted attrition (%)", metric: "percent", start: 12, target: 6, current: 9, weight: 50 }] });
    const app = await goals.createObjective(tx, asha, { level: "department", departmentId: eng.id, periodId: current, parentId: growth.id, title: "Ship the mobile app to all customers", weight: 50, dueDate: due });
    const deals = await goals.createObjective(tx, asha, { level: "department", departmentId: sales.id, periodId: current, parentId: growth.id, title: "Close 40 new mid-market accounts", weight: 50, dueDate: due,
      keyResults: [{ title: "Accounts closed", metric: "number", start: 0, target: 40, current: 14, weight: 100 }] });
    const r1 = await goals.createObjective(tx, rohan, { level: "individual", periodId: current, parentId: app.id, title: "Release the app on both stores", weight: 60, dueDate: due,
      keyResults: [{ title: "Beta testers onboarded", metric: "number", start: 0, target: 200, current: 140, weight: 50 }, { title: "Crash-free sessions (%)", metric: "percent", start: 90, target: 99.5, current: 97, weight: 50 }] });
    const a1 = await goals.createObjective(tx, rohan, { level: "individual", ownerId: arjun.employeeId, periodId: current, parentId: r1.id, title: "Build offline sync for the app", weight: 70, dueDate: addDaysISO(today, 30),
      keyResults: [{ title: "Sync design reviewed", metric: "boolean", start: 0, target: 1, weight: 30 }, { title: "Screens working offline", metric: "number", start: 0, target: 12, current: 3, weight: 70 }] });
    const m1 = await goals.createObjective(tx, meera, { level: "individual", periodId: current, parentId: r1.id, title: "Cut app start-up time in half", weight: 100, dueDate: addDaysISO(today, -5),
      keyResults: [{ title: "Cold start (ms)", metric: "number", start: 2400, target: 1200, current: 1900, weight: 100 }] });
    await goals.createObjective(tx, arjun, { level: "individual", periodId: current, title: "Get the AWS architect certificate", weight: 30, visibility: "private", dueDate: addDaysISO(today, 60) });
    const s1 = await goals.createObjective(tx, sneha, { level: "individual", periodId: current, parentId: deals.id, title: "Open the Pune and Nagpur markets", weight: 100, dueDate: due,
      keyResults: [{ title: "Qualified meetings", metric: "number", start: 0, target: 60, current: 41, weight: 100 }] });
    await goals.createObjective(tx, sneha, { level: "individual", ownerId: imran.employeeId, periodId: current, parentId: deals.id, title: "Close 10 accounts in Nagpur", weight: 100, dueDate: due,
      keyResults: [{ title: "Accounts closed", metric: "number", start: 0, target: 10, current: 2, weight: 100 }] });
    // last quarter, closed out
    await goals.createObjective(tx, priya, { level: "individual", periodId: previous, title: "Roll out the new leave policy", weight: 100, keyResults: [{ title: "Policy acknowledged by everyone", metric: "percent", start: 0, target: 100, current: 100, weight: 100 }] });
    await goals.createObjective(tx, priya, { level: "individual", periodId: current, parentId: people.id, title: "Launch quarterly engagement survey", weight: 100, dueDate: due });
    return { growth: growth.id, app: app.id, r1: r1.id, a1: a1.id, m1: m1.id, s1: s1.id };
  });
  await tx1(async (tx) => {
    const krs = async (o: string) => tx<{ id: string; title: string }[]>`select id, title from key_results where objective_id = ${o} order by created_at`;
    const [design, screens] = await krs(ids.a1);
    await goals.checkIn(tx, arjun, ids.a1, { status: "on_track", comment: "Design signed off by Rohan; started on the orders screen.", keyResults: [{ id: design.id, current: 1 }, { id: screens.id, current: 3 }] });
    await goals.checkIn(tx, arjun, ids.a1, { status: "at_risk", comment: "Conflict handling is harder than planned. Need a day with the API team.", keyResults: [{ id: screens.id, current: 5 }] });
    const [cold] = await krs(ids.m1);
    await goals.checkIn(tx, meera, ids.m1, { status: "behind", comment: "Lazy-loading fonts saved 300 ms. Image decoding is the next big chunk.", keyResults: [{ id: cold.id, current: 1900 }] });
    const [meet] = await krs(ids.s1);
    await goals.checkIn(tx, sneha, ids.s1, { status: "on_track", comment: "Two partner events booked for next month.", keyResults: [{ id: meet.id, current: 41 }] });
  });

  // ---------- feedback ----------
  await tx1(async (tx) => {
    await fb.giveFeedback(tx, rohan, { toId: arjun.employeeId, body: "The sync design doc was clear and well argued. Walking the team through the trade-offs saved us a week.", visibility: "manager" });
    await fb.giveFeedback(tx, meera, { toId: vikram.employeeId, body: "Thanks for jumping on the VPN issue so quickly last week. It unblocked the whole team.", visibility: "public" });
    await fb.giveFeedback(tx, sneha, { toId: imran.employeeId, body: "Your Nagpur pitch was strong. Next time bring two customer stories — they land better than the feature list.", visibility: "private" });
    await fb.requestFeedback(tx, arjun, { askIds: [meera.employeeId, vikram.employeeId], question: "How did the sync design review go from your side? Anything I should do differently?" });
    await fb.requestFeedback(tx, rohan, { askIds: [vikram.employeeId], aboutId: meera.employeeId, question: "How has Meera been as a code reviewer this quarter?" });
    const [req] = await tx<{ id: string }[]>`select id from feedback_items where kind = 'request' and to_employee_id = ${meera.employeeId} and status = 'pending' limit 1`;
    await fb.respondToRequest(tx, meera, req.id, { body: "Clear and calm. I'd split the review into two sessions next time — the second hour dragged.", visibility: "private" });
    await fb.addNote(tx, rohan, { aboutId: meera.employeeId, body: "Talked about start-up time slipping. She has a plan; check again in two weeks." });
  });

  // ---------- 1:1s ----------
  await tx1(async (tx) => {
    const lastWeek = new Date(`${addDaysISO(today, -7)}T10:30:00+05:30`);
    const m = await one.scheduleOneOnOne(tx, rohan, { attendeeId: arjun.employeeId, startsAt: lastWeek.toISOString(), durationMins: 30, recurrence: "weekly", purpose: "Weekly catch-up", agenda: ["Offline sync progress", "Conference talk idea"] });
    await one.addItem(tx, arjun, m.id, { kind: "agenda", body: "Can I get a second laptop screen?" });
    await one.addItem(tx, rohan, m.id, { kind: "private_note", body: "Arjun seems stretched. Watch the at-risk goal." });
    const done = await one.addItem(tx, rohan, m.id, { kind: "action_item", body: "Order a monitor for Arjun", assigneeId: rohan.employeeId });
    await one.setActionDone(tx, rohan, done.id, true);
    await one.addItem(tx, arjun, m.id, { kind: "action_item", body: "Write the conflict-handling proposal", assigneeId: arjun.employeeId, dueDate: addDaysISO(today, 3) });
    await one.saveSharedNotes(tx, rohan, m.id, "Sync is at risk because of conflict handling. Arjun will write a proposal; Rohan sets up time with the API team.");
    await one.completeMeeting(tx, rohan, m.id);   // next week's meeting created, the open action item moves to it
    await one.scheduleOneOnOne(tx, asha, { attendeeId: priya.employeeId, startsAt: new Date(`${addDaysISO(today, 2)}T16:00:00+05:30`).toISOString(), durationMins: 45, recurrence: "monthly", purpose: "People priorities", agenda: ["Engagement survey plan", "Review cycle timeline"] });
    await one.scheduleOneOnOne(tx, sneha, { attendeeId: imran.employeeId, startsAt: new Date(`${addDaysISO(today, 1)}T11:00:00+05:30`).toISOString(), durationMins: 30, recurrence: "biweekly", purpose: "Pipeline review" });
  });

  // ---------- reviews ----------
  const cycles = await tx1(async (tx) => {
    const lib = await tx<{ id: string; name: string; kind: string }[]>`select id, name, kind from competencies`;
    const pick = (kind: string) => lib.filter((c) => c.kind === kind).map((c) => ({ id: c.id, text: c.name, rated: true }));
    const form = await rv.saveForm(tx, asha, null, { name: "Standard review", sections: [
      { id: "q", type: "questions", title: "Looking back", weight: 30, items: [
        { id: "q1", text: "Quality and impact of the work", rated: true }, { id: "q2", text: "Delivering on commitments", rated: true }, { id: "q3", text: "What should they keep doing, and what should change?", rated: false, required: true }] },
      { id: "g", type: "goals", title: "Goals", weight: 40, items: [] },
      { id: "v", type: "core_values", title: "Core values", weight: 30, items: pick("core_value") },
    ] });
    const reviewers = { self: true, manager: true, skip_level: false, peer: { enabled: true, min: 1, max: 3, nominated_by: "employee" as const, needs_approval: true } };
    const h1 = await rv.createCycle(tx, asha, { name: `H1 ${year} review`, kind: "standard", periodStart: `${year}-01-01`, periodEnd: `${year}-06-30`, formId: form.id,
      timelines: { self_due: addDaysISO(today, -60), manager_due: addDaysISO(today, -45), publish_on: addDaysISO(today, -30) },
      reviewers: { ...reviewers, peer: { ...reviewers.peer, enabled: false } }, employeeFilter: { exclude_ids: [asha.employeeId] } });
    await rv.launchCycle(tx, asha, h1.id);
    const q3 = await rv.createCycle(tx, asha, { name: `Q3 ${year} review`, kind: "standard", periodStart: `${year}-07-01`, periodEnd: `${year}-09-30`, formId: form.id,
      timelines: { nominate_due: addDaysISO(today, 3), self_due: addDaysISO(today, 10), peer_due: addDaysISO(today, 14), manager_due: addDaysISO(today, 21), calibration_due: addDaysISO(today, 28) },
      reviewers, employeeFilter: { department_ids: (await tx<{ id: string }[]>`select id from departments where name in ('Engineering','Sales')`).map((d) => d.id) } });
    await rv.launchCycle(tx, asha, q3.id);
    const nj = await rv.createCycle(tx, asha, { name: "90-day new joiner review", kind: "new_joiner", periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, formId: form.id,
      timelines: {}, reviewers: { ...reviewers, peer: { ...reviewers.peer, enabled: false } }, autoRule: { trigger: "joining", days: 90 } });
    await rv.launchCycle(tx, asha, nj.id);
    return { h1: h1.id, q3: q3.id, form: form.id };
  });
  // H1: everyone reviewed, calibrated, published
  const ratingOf: Record<string, number> = { Rohan: 4, Priya: 4, Karan: 3, Arjun: 4, Meera: 3, Vikram: 3, Sneha: 5, Imran: 2, Divya: 3, Aditya: 3, Fatima: 4 };
  await tx1(async (tx) => {
    const rows = await tx<{ id: string; reviewer: string; reviewee: string; type: string }[]>`
      select a.id, a.reviewer_employee_id as reviewer, e.first_name as reviewee, a.reviewer_type as type from review_assignments a join employees e on e.id = a.reviewee_employee_id where a.cycle_id = ${cycles.h1}`;
    const people = new Map<string, Actor>();
    for (const r of rows) {
      if (!people.has(r.reviewer)) {
        const [e] = await tx<{ user_id: string; display_name: string }[]>`select user_id, display_name from employees where id = ${r.reviewer}`;
        people.set(r.reviewer, { tenant, userId: e.user_id, employeeId: r.reviewer, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(), grants: [] });
      }
      const who = people.get(r.reviewer)!;
      const d = await rv.reviewDetail(tx, who, r.id);
      const base = ratingOf[r.reviewee] ?? 3;
      const score = r.type === "self" ? Math.min(5, base + 1) : base;
      const answers: Record<string, { rating?: number; comment?: string }> = {};
      for (const s of d!.sections) for (const i of s.items) answers[`${s.id}:${i.id}`] = i.rated ? { rating: score } : { comment: r.type === "self" ? "I kept my commitments and want to take on more ownership next half." : "Keep the steady delivery; take on a stretch project next half." };
      await rv.submitReview(tx, who, r.id, answers);
    }
    await rv.advanceCycle(tx, asha, cycles.h1, "calibration");
    const [imranO] = await tx<{ id: string }[]>`select o.id from review_outcomes o join employees e on e.id = o.employee_id where o.cycle_id = ${cycles.h1} and e.first_name = 'Imran'`;
    await rv.setFinalRating(tx, asha, imranO.id, { finalRating: 2.5, potential: 3, note: "New to the territory; the Nagpur pipeline he built counts for more than closed deals this half." });
    for (const [name, pot] of [["Sneha", 3], ["Rohan", 3], ["Arjun", 2], ["Meera", 2], ["Karan", 2], ["Divya", 1]] as const) {
      const [o] = await tx<{ id: string; computed_rating: string }[]>`select o.id, o.computed_rating from review_outcomes o join employees e on e.id = o.employee_id where o.cycle_id = ${cycles.h1} and e.first_name = ${name}`;
      await rv.setFinalRating(tx, asha, o.id, { finalRating: Number(o.computed_rating), potential: pot, note: null });
    }
    await rv.publishResults(tx, asha, cycles.h1, null);
  });
  // Q3: some self reviews done, peers picked (one waiting for approval)
  await tx1(async (tx) => {
    const self = await tx<{ id: string; reviewer: string }[]>`select a.id, e.first_name as reviewer from review_assignments a join employees e on e.id = a.reviewer_employee_id where a.cycle_id = ${cycles.q3} and a.reviewer_type = 'self'`;
    for (const s of self.filter((x) => ["Arjun", "Vikram"].includes(x.reviewer))) {
      const who = s.reviewer === "Arjun" ? arjun : vikram;
      const d = await rv.reviewDetail(tx, who, s.id);
      const answers: Record<string, { rating?: number; comment?: string }> = {};
      for (const sec of d!.sections) for (const i of sec.items) answers[`${sec.id}:${i.id}`] = i.rated ? { rating: 4 } : { comment: "Shipped the sync groundwork; want to mentor a junior next quarter." };
      if (s.reviewer === "Arjun") await rv.submitReview(tx, who, s.id, answers); else await rv.saveDraft(tx, who, s.id, answers);
    }
    await rv.nominatePeers(tx, arjun, cycles.q3, arjun.employeeId, [meera.employeeId, vikram.employeeId]);
    const [one1] = await tx<{ id: string }[]>`select id from review_assignments where cycle_id = ${cycles.q3} and reviewee_employee_id = ${arjun.employeeId} and reviewer_employee_id = ${vikram.employeeId} and reviewer_type = 'peer'`;
    await rv.decideNomination(tx, rohan, one1.id, true);
    await rv.nominatePeers(tx, meera, cycles.q3, meera.employeeId, [arjun.employeeId]);
  });

  // ---------- PIP ----------
  await tx1((tx) => pip.createPip(tx, sneha, { employeeId: imran.employeeId, reason: "Closed deals have trailed the team for two quarters. This plan sets clear targets and weekly support for the next 60 days.",
    goals: [{ title: "Close 4 accounts", measure: "Signed contracts in the CRM" }, { title: "Hold 15 qualified meetings", measure: "Logged with notes" }, { title: "Shadow Sneha on 3 enterprise calls", measure: null }],
    startsOn: addDaysISO(today, -14), endsOn: addDaysISO(today, 46) }).then(async (r) => {
    await pip.pipCheckIn(tx, sneha, r.id, { status: "at_risk", note: "One account closed, two in legal review. Meetings on track." });
    await pip.pipCheckIn(tx, imran, r.id, { status: "on_track", note: "The shadowing has helped a lot. Two more calls scheduled." });
  }));

  // ---------- compensation ----------
  await tx1(async (tx) => {
    const c = await comp.createCompCycle(tx, asha, { name: `Annual increments ${year + 1}`, reviewCycleId: cycles.h1, effectiveFrom: `${year + 1}-04-01`, budgetPaise: 15_00_000_00,
      matrix: [
        { rating_min: 1, rating_max: 2.49, increment_pct_min: 0, increment_pct_max: 3, increment_pct_default: 0 },
        { rating_min: 2.5, rating_max: 3.49, increment_pct_min: 4, increment_pct_max: 8, increment_pct_default: 6 },
        { rating_min: 3.5, rating_max: 4.49, increment_pct_min: 8, increment_pct_max: 14, increment_pct_default: 10 },
        { rating_min: 4.5, rating_max: 5, increment_pct_min: 12, increment_pct_max: 20, increment_pct_default: 15 },
      ] });
    await comp.openRecommendations(tx, asha, c.id);
    const [a] = await tx<{ id: string }[]>`select id from comp_proposals where cycle_id = ${c.id} and employee_id = ${arjun.employeeId}`;
    await comp.recommend(tx, rohan, a.id, { incrementBp: 1200, note: "Carried the sync work; strong half." });
  });
  void karan; void divya;
}
