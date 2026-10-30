import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import { assertLeaveAdmin } from "./access";
import { holidayListNameFor } from "./service";

const audit = (tx: Tx, actor: Actor, entity: string, id: string | null, action: string, diff?: unknown) =>
  tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
     values (${actor.tenant.id}, ${actor.userId}, ${entity}, ${id}, ${action}, ${diff === undefined ? null : tx.json(diff as never)})`;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");

export type HolidayList = {
  id: string; name: string; year: number; floater_limit: number; holidays: number; floaters: number;
  locations: { id: string; name: string }[]; people: number;
};
export type Holiday = { id: string; holiday_list_id: string; name: string; date: string; is_floater: boolean; description: string | null; chosen: number };

export async function listHolidayLists(tx: Tx) {
  const [lists, holidays, locations] = await Promise.all([
    tx<Omit<HolidayList, "locations">[]>`
      select hl.id, hl.name, hl.year, hl.floater_limit,
        (select count(*)::int from holidays h where h.holiday_list_id = hl.id and not h.is_floater) as holidays,
        (select count(*)::int from holidays h where h.holiday_list_id = hl.id and h.is_floater) as floaters,
        (select count(*)::int from employees e where e.holiday_list_id = hl.id and e.status <> 'relieved') as people
      from holiday_lists hl order by hl.year desc, hl.name`,
    tx<Holiday[]>`
      select h.id, h.holiday_list_id, h.name, h.date::text, h.is_floater, h.description,
        (select count(*)::int from floater_choices f where f.holiday_id = h.id) as chosen
      from holidays h order by h.date`,
    tx<{ id: string; name: string; default_holiday_list_id: string | null }[]>`select id, name, default_holiday_list_id from locations order by name`,
  ]);
  return {
    lists: lists.map((l) => ({ ...l, locations: locations.filter((x) => x.default_holiday_list_id === l.id).map((x) => ({ id: x.id, name: x.name })) })),
    holidays, locations: locations.map((l) => ({ id: l.id, name: l.name, listId: l.default_holiday_list_id })),
  };
}

const listInput = z.object({ name: z.string().trim().min(1, "Enter a name").max(80), year: z.number().int().min(2000).max(2100), floaterLimit: z.number().int().min(0).max(20) });

export async function saveHolidayList(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  assertLeaveAdmin(actor);
  const p = listInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  try {
    if (!id) {
      const [r] = await tx.savepoint((sp) => sp<{ id: string }[]>`
        insert into holiday_lists (tenant_id, name, year, floater_limit) values (${actor.tenant.id}, ${v.name}, ${v.year}, ${v.floaterLimit}) returning id`);
      await audit(tx, actor, "holiday_list", r.id, "create", v);
      return { id: r.id };
    }
    const [cur] = await tx<{ year: number }[]>`select year from holiday_lists where id = ${id}`;
    if (!cur) throw new AppError("not_found", "Holiday list not found.");
    if (cur.year !== v.year) {
      const [h] = await tx`select 1 from holidays where holiday_list_id = ${id} limit 1`;
      if (h) throw new AppError("invalid", "This list already has holidays, so its year can't change. Copy it to a new year instead.", "year");
    }
    await tx.savepoint((sp) => sp`update holiday_lists set name = ${v.name}, year = ${v.year}, floater_limit = ${v.floaterLimit}, updated_at = now() where id = ${id}`);
    await audit(tx, actor, "holiday_list", id, "update", v);
    return { id };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", `There's already a list called ${v.name} for ${v.year}.`, "name");
    throw e;
  }
}

export async function deleteHolidayList(tx: Tx, actor: Actor, id: string) {
  assertLeaveAdmin(actor);
  const [r] = await tx<{ name: string }[]>`delete from holiday_lists where id = ${id} returning name`;
  if (!r) throw new AppError("not_found", "Holiday list not found.");
  await audit(tx, actor, "holiday_list", id, "delete", { name: r.name });
}

/** Same list for another year: fixed-date holidays keep their day and month (check festivals, they move). */
export async function copyHolidayList(tx: Tx, actor: Actor, id: string, toYear: number) {
  assertLeaveAdmin(actor);
  const [src] = await tx<{ name: string; year: number; floater_limit: number }[]>`select name, year, floater_limit from holiday_lists where id = ${id}`;
  if (!src) throw new AppError("not_found", "Holiday list not found.");
  const r = await saveHolidayList(tx, actor, null, { name: src.name, year: toYear, floaterLimit: src.floater_limit });
  await tx`
    insert into holidays (tenant_id, holiday_list_id, name, date, is_floater, description)
    select tenant_id, ${r.id}, name, (date + make_interval(years => ${toYear}::int - extract(year from date)::int))::date, is_floater, description
    from holidays where holiday_list_id = ${id}
    on conflict do nothing`;
  return r;
}

const holidayInput = z.object({ name: z.string().trim().min(1, "Enter a name").max(80), date: isoDate, floater: z.boolean(), description: z.string().trim().max(300).optional().nullable() });

export async function saveHoliday(tx: Tx, actor: Actor, listId: string, id: string | null, raw: unknown) {
  assertLeaveAdmin(actor);
  const p = holidayInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const [list] = await tx<{ year: number }[]>`select year from holiday_lists where id = ${listId}`;
  if (!list) throw new AppError("not_found", "Holiday list not found.");
  if (Number(v.date.slice(0, 4)) !== list.year) throw new AppError("invalid", `This list is for ${list.year}. Pick a date in ${list.year}.`, "date");
  try {
    if (!id) {
      const [r] = await tx.savepoint((sp) => sp<{ id: string }[]>`
        insert into holidays (tenant_id, holiday_list_id, name, date, is_floater, description)
        values (${actor.tenant.id}, ${listId}, ${v.name}, ${v.date}, ${v.floater}, ${v.description || null}) returning id`);
      await audit(tx, actor, "holiday", r.id, "create", v);
      return { id: r.id };
    }
    const [r] = await tx.savepoint((sp) => sp<{ id: string }[]>`
      update holidays set name = ${v.name}, date = ${v.date}, is_floater = ${v.floater}, description = ${v.description || null}, updated_at = now()
      where id = ${id} and holiday_list_id = ${listId} returning id`);
    if (!r) throw new AppError("not_found", "Holiday not found.");
    if (!v.floater) await tx`delete from floater_choices where holiday_id = ${id}`;   // no longer optional: everyone gets it
    await audit(tx, actor, "holiday", id, "update", v);
    return { id };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", "This holiday is already on the list for that date.", "date");
    throw e;
  }
}

export async function deleteHoliday(tx: Tx, actor: Actor, id: string) {
  assertLeaveAdmin(actor);
  const [r] = await tx<{ name: string }[]>`delete from holidays where id = ${id} returning name`;
  if (!r) throw new AppError("not_found", "Holiday not found.");
  await audit(tx, actor, "holiday", id, "delete", { name: r.name });
}

/** A list becomes the default for these locations; people listed get it as a personal override. */
export async function assignHolidayList(tx: Tx, actor: Actor, listId: string, input: { locationIds: string[]; employeeIds: string[] }) {
  assertLeaveAdmin(actor);
  const [list] = await tx`select 1 from holiday_lists where id = ${listId}`;
  if (!list) throw new AppError("not_found", "Holiday list not found.");
  await tx`update locations set default_holiday_list_id = null, updated_at = now() where default_holiday_list_id = ${listId} and not (id = any(${input.locationIds}::uuid[]))`;
  if (input.locationIds.length) await tx`update locations set default_holiday_list_id = ${listId}, updated_at = now() where id = any(${input.locationIds}::uuid[])`;
  await tx`update employees set holiday_list_id = null, updated_at = now() where holiday_list_id = ${listId} and not (id = any(${input.employeeIds}::uuid[]))`;
  if (input.employeeIds.length) await tx`update employees set holiday_list_id = ${listId}, updated_at = now() where id = any(${input.employeeIds}::uuid[])`;
  await audit(tx, actor, "holiday_list", listId, "assign", input);
}

export async function holidayListPeople(tx: Tx, listId: string) {
  return (await tx<{ id: string }[]>`select id from employees where holiday_list_id = ${listId} and status <> 'relieved'`).map((r) => r.id);
}

// ---------------------------------------------------------------- employee view

export type UpcomingHoliday = { id: string; name: string; date: string; floater: boolean; chosen: boolean; listId: string; description: string | null };

/** The person's holidays from today for a year ahead, floaters included (with whether they picked them), plus floater allowance per list. */
export async function upcomingHolidays(tx: Tx, employeeId: string, today: ISODate = todayIn()) {
  const name = await holidayListNameFor(tx, employeeId);
  if (!name) return { listName: null, holidays: [] as UpcomingHoliday[], allowance: [] as { listId: string; year: number; limit: number; used: number }[] };
  const [holidays, lists] = await Promise.all([
    tx<UpcomingHoliday[]>`
      select h.id, h.name, h.date::text, h.is_floater as floater, h.description, h.holiday_list_id as "listId",
             exists (select 1 from floater_choices f where f.holiday_id = h.id and f.employee_id = ${employeeId}) as chosen
      from holidays h join holiday_lists hl on hl.id = h.holiday_list_id
      where hl.name = ${name} and h.date >= ${today} and h.date <= ${addDaysISO(today, 366)} order by h.date`,
    tx<{ listId: string; year: number; limit: number; used: number }[]>`
      select hl.id as "listId", hl.year, hl.floater_limit as limit,
        (select count(*)::int from floater_choices f join holidays h on h.id = f.holiday_id where h.holiday_list_id = hl.id and f.employee_id = ${employeeId}) as used
      from holiday_lists hl where hl.name = ${name} and hl.year >= ${Number(today.slice(0, 4))} order by hl.year`,
  ]);
  return { listName: name, holidays, allowance: lists };
}

/** Opt in or out of a floater (optional) holiday on the person's own list, within the list's yearly limit. Past days are fixed. */
export async function chooseFloater(tx: Tx, actor: Actor, holidayId: string, on: boolean) {
  await tx`select pg_advisory_xact_lock(hashtext(${"floater:" + actor.employeeId}))`;
  const [h] = await tx<{ id: string; name: string; date: string; is_floater: boolean; list_id: string; list_name: string; floater_limit: number }[]>`
    select h.id, h.name, h.date::text, h.is_floater, hl.id as list_id, hl.name as list_name, hl.floater_limit
    from holidays h join holiday_lists hl on hl.id = h.holiday_list_id where h.id = ${holidayId}`;
  const mine = await holidayListNameFor(tx, actor.employeeId);
  if (!h || h.list_name !== mine) throw new AppError("not_found", "This holiday isn't on your holiday list.");
  if (!h.is_floater) throw new AppError("invalid", `${h.name} is a holiday for everyone; there's nothing to pick.`);
  if (h.date < todayIn()) throw new AppError("invalid", "This day has passed, so your choice can't change.");
  if (on) {
    const [{ used }] = await tx<{ used: number }[]>`
      select count(*)::int as used from floater_choices f join holidays x on x.id = f.holiday_id where x.holiday_list_id = ${h.list_id} and f.employee_id = ${actor.employeeId}`;
    const [already] = await tx`select 1 from floater_choices where holiday_id = ${holidayId} and employee_id = ${actor.employeeId}`;
    if (already) return { chosen: true };
    if (used >= h.floater_limit) throw new AppError("invalid", h.floater_limit === 0 ? "Your holiday list doesn't include any optional holidays to pick." : `You can pick ${h.floater_limit} optional ${h.floater_limit === 1 ? "holiday" : "holidays"} this year and you've used ${used === 1 ? "it" : "them all"}. Drop one to pick another.`);
    await tx`insert into floater_choices (holiday_id, employee_id, tenant_id) values (${holidayId}, ${actor.employeeId}, ${actor.tenant.id})`;
  } else {
    await tx`delete from floater_choices where holiday_id = ${holidayId} and employee_id = ${actor.employeeId}`;
  }
  return { chosen: on };
}
