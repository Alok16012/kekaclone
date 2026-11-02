/**
 * Demo data for hiring on the seeded tenant (called from db/seed.ts): Aditya as recruiter, an approved requisition turned
 * into the "Backend Engineer" job, a requisition waiting for Asha and a backfill draft for Divya, three more jobs,
 * candidates in every stage (careers page, referral, import-style, internal), interviews (one upcoming, one waiting for
 * the candidate to pick a slot, one with feedback), an offer waiting for an answer and one accepted with documents.
 */
import { withTenant } from "@/server/db";
import { sha256 } from "@/server/auth/password";
import type { Actor } from "@/server/auth/session";
import { decide } from "@/server/modules/approvals/service";
import { renderLetterPdf } from "@/server/modules/documents/pdf";
import { addDaysISO, todayIn } from "@/lib/dates";
import * as setup from "@/server/modules/hire/setup";
import * as jobs from "@/server/modules/hire/jobs";
import * as cands from "@/server/modules/hire/candidates";
import * as iv from "@/server/modules/hire/interviews";
import * as offers from "@/server/modules/hire/offers";
import * as pub from "@/server/modules/hire/public";
import * as internal from "@/server/modules/hire/internal";

const HOUR = 3600_000;

/** A one-page resume PDF (real text, so resume parsing has something to read). */
export async function resumePdf(name: string, email: string, phone: string, years: number, skills: string[]) {
  const html = `<h2>${name}</h2><p>${email} | ${phone}</p><h3>Summary</h3><p>${years} years of experience building products with ${skills.join(", ")}.</p>` +
    `<h3>Experience</h3><ul><li>Senior engineer, Globex Systems (2022 to now)</li><li>Engineer, Initech (2019 to 2022)</li></ul><h3>Skills</h3><p>${skills.join(", ")}</p>`;
  return renderLetterPdf({ html, title: `Resume - ${name}`, company: name, footer: "Resume" });
}

export async function seedHire(tenantId: string) {
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[] = []): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes: [] }] : [] };
  };
  const HR = ["employees.read", "employees.write", "hire.admin", "exits.manage", "documents.manage"];
  const asha = await actor("Asha", ["*"]), priya = await actor("Priya", HR), aditya = await actor("Aditya", ["hire.recruit"]);
  const [rohan, arjun, meera, vikram, sneha, imran, fatima] = await Promise.all(["Rohan", "Arjun", "Meera", "Vikram", "Sneha", "Imran", "Fatima"].map((n) => actor(n)));
  const today = todayIn();
  const ids = await withTenant(tenantId, async (tx) => {
    await setup.ensureHireDefaults(tx, tenantId);
    await tx`update roles set permissions = (select array_agg(distinct p) from unnest(permissions || ${["hire.admin"]}::text[]) p) where key = 'hr_admin'`;
    await tx`insert into role_assignments (tenant_id, role_id, employee_id) select ${tenantId}, id, ${aditya.employeeId} from roles where key = 'recruiter'`;
    const one = async (q: Promise<{ id: string }[]>) => (await q)[0].id;
    return {
      eng: await one(tx<{ id: string }[]>`select id from departments where name = 'Engineering'`),
      sales: await one(tx<{ id: string }[]>`select id from departments where name = 'Sales'`),
      ops: await one(tx<{ id: string }[]>`select id from departments where name = 'Operations'`),
      people: await one(tx<{ id: string }[]>`select id from departments where name = 'People'`),
      office: await one(tx<{ id: string }[]>`select id from locations order by created_at limit 1`),
      flow: await one(tx<{ id: string }[]>`select id from hiring_flows where is_default`),
      swe: await one(tx<{ id: string }[]>`select id from designations where title = 'Software Engineer'`),
      jdSwe: await tx<{ description_html: string }[]>`select description_html from jd_templates where name = 'Software engineer'`.then((r) => r[0].description_html),
      jdSales: await tx<{ description_html: string }[]>`select description_html from jd_templates where name = 'Sales executive'`.then((r) => r[0].description_html),
      offerTemplate: await one(tx<{ id: string }[]>`select id from letter_templates where kind = 'offer' limit 1`),
      scorecard: await one(tx<{ id: string }[]>`select id from scorecards limit 1`),
    };
  });
  const run = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) => withTenant(tenantId, fn);
  const pending = async (entityId: string) => run(async (tx) => (await tx<{ id: string; approver_employee_id: string }[]>`
    select s.id, s.approver_employee_id from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${entityId} and s.status = 'pending'`)[0]);
  const approveAll = async (entityId: string) => {
    const who: Record<string, Actor> = { [asha.employeeId]: asha, [priya.employeeId]: priya, [rohan.employeeId]: rohan, [sneha.employeeId]: sneha };
    for (let s = await pending(entityId); s; s = await pending(entityId)) await run((tx) => decide(tx, who[s.approver_employee_id], s.id, "approved", "Looks good"));
  };

  // ---------- requisitions ----------
  const be = await run((tx) => jobs.saveRequisition(tx, rohan, null, {
    title: "Backend Engineer", openings: 2, jobType: "full_time", departmentId: ids.eng, locationId: ids.office, salaryMinPaise: 18_00_000_00, salaryMaxPaise: 28_00_000_00,
    targetDate: addDaysISO(today, 60), description: "Two engineers to grow the payments platform team.", qualification: "B.E./B.Tech or equivalent experience", experienceMin: 3, experienceMax: 6, backfillForId: null,
  }));
  await run((tx) => jobs.submitRequisition(tx, rohan, be.id));
  await approveAll(be.id);
  const { jobId: backend } = await run((tx) => jobs.convertRequisition(tx, aditya, be.id));
  await run((tx) => jobs.saveJob(tx, aditya, backend, {
    title: "Backend Engineer", departmentId: ids.eng, locationId: ids.office, descriptionHtml: ids.jdSwe, openings: 2, targetDate: addDaysISO(today, 60), jobType: "full_time",
    experienceMin: 3, experienceMax: 6, salaryMinPaise: 18_00_000_00, salaryMaxPaise: 28_00_000_00, showSalary: true, hiringFlowId: ids.flow, reapplyAfterDays: 90,
    team: [{ employeeId: aditya.employeeId, role: "recruiter" }, { employeeId: rohan.employeeId, role: "hiring_manager" }, { employeeId: arjun.employeeId, role: "panelist" }, { employeeId: meera.employeeId, role: "panelist" }],
    publish: { careerSite: true, internal: true, referrals: true },
  }));
  await run((tx) => jobs.setJobStatus(tx, aditya, backend, "publish"));

  const se = await run((tx) => jobs.saveRequisition(tx, sneha, null, {
    title: "Senior Sales Executive", openings: 1, jobType: "full_time", departmentId: ids.sales, locationId: ids.office, salaryMinPaise: 9_00_000_00, salaryMaxPaise: 14_00_000_00,
    targetDate: addDaysISO(today, 45), description: "Grow the west region accounts.", qualification: null, experienceMin: 4, experienceMax: 8, backfillForId: null,
  }));
  await run((tx) => jobs.submitRequisition(tx, sneha, se.id));   // waits for Asha in her inbox
  const leaving = await run((tx) => jobs.backfillCandidates(tx));
  const divya = leaving.find((l) => l.name.startsWith("Divya"));
  if (divya) await run((tx) => jobs.saveRequisition(tx, priya, null, {
    title: "Operations Associate", openings: 1, jobType: "full_time", departmentId: divya.department_id, locationId: divya.location_id, salaryMinPaise: null, salaryMaxPaise: null,
    targetDate: divya.last_working_date, description: `Backfill for ${divya.name}.`, qualification: null, experienceMin: 1, experienceMax: 3, backfillForId: divya.employee_id,
  }));

  // ---------- other jobs ----------
  const ae = await run((tx) => jobs.saveJob(tx, aditya, null, {
    title: "Account Executive", departmentId: ids.sales, locationId: ids.office, descriptionHtml: ids.jdSales, openings: 1, targetDate: addDaysISO(today, 40), jobType: "full_time",
    experienceMin: 2, experienceMax: 5, salaryMinPaise: null, salaryMaxPaise: null, showSalary: false, hiringFlowId: ids.flow, reapplyAfterDays: 60,
    team: [{ employeeId: aditya.employeeId, role: "recruiter" }, { employeeId: sneha.employeeId, role: "hiring_manager" }, { employeeId: imran.employeeId, role: "panelist" }],
    publish: { careerSite: true, internal: false, referrals: true },
  }));
  await run((tx) => jobs.setJobStatus(tx, aditya, ae.id, "publish"));
  const csm = await run((tx) => jobs.saveJob(tx, aditya, null, {
    title: "Customer Success Manager", departmentId: ids.ops, locationId: ids.office, descriptionHtml: "<p>Look after our largest customers after they go live, and make sure they get value from erp every month.</p>", openings: 1,
    targetDate: null, jobType: "full_time", experienceMin: 2, experienceMax: 6, salaryMinPaise: null, salaryMaxPaise: null, showSalary: false, hiringFlowId: ids.flow, reapplyAfterDays: null,
    team: [{ employeeId: aditya.employeeId, role: "recruiter" }, { employeeId: priya.employeeId, role: "hiring_manager" }], publish: { careerSite: false, internal: true, referrals: false },
  }));
  await run((tx) => jobs.setJobStatus(tx, aditya, csm.id, "publish"));
  await run((tx) => jobs.saveJob(tx, aditya, null, {
    title: "Product Designer", departmentId: ids.eng, locationId: ids.office, descriptionHtml: "<p>Design flows people use every day, from research to polished screens.</p>", openings: 1, targetDate: null, jobType: "full_time",
    experienceMin: 2, experienceMax: 5, salaryMinPaise: null, salaryMaxPaise: null, showSalary: false, hiringFlowId: ids.flow, reapplyAfterDays: 90,
    team: [{ employeeId: aditya.employeeId, role: "recruiter" }, { employeeId: rohan.employeeId, role: "hiring_manager" }], publish: { careerSite: true, internal: true, referrals: true },
  }));

  // ---------- candidates ----------
  const stages = await run((tx) => tx<{ id: string; name: string }[]>`select id, name from hiring_stages where flow_id = ${ids.flow} order by position`);
  const stage = (n: string) => stages.find((s) => s.name === n)!.id;
  const add = async (job: string, c: { first: string; last: string; email: string; mobile: string; company: string; title: string; years: number; source: string; tags: string[]; skills?: string[] }) => {
    const resume = c.skills ? { name: `${c.first} ${c.last} resume.pdf`, bytes: await resumePdf(`${c.first} ${c.last}`, c.email, c.mobile, c.years, c.skills) } : null;
    return run((tx) => cands.createCandidate(tx, aditya, {
      firstName: c.first, lastName: c.last, email: c.email, mobile: c.mobile, gender: null, currentCompany: c.company, currentTitle: c.title, experienceMonths: c.years * 12,
      source: c.source, tags: c.tags, custom: {},
    }, { jobId: job, resume }));
  };
  const move = (appId: string, name: string) => run((tx) => cands.moveApplication(tx, aditya, appId, stage(name)));

  // careers page
  const nehaCv = await resumePdf("Neha Gupta", "neha.gupta@example.com", "+91 98450 12345", 4, ["Java", "PostgreSQL", "AWS"]);
  await run((tx) => pub.applyPublic(tx, tenant, {
    jobId: backend, firstName: "Neha", lastName: "Gupta", email: "neha.gupta@example.com", mobile: "+91 98450 12345", currentCompany: "Globex Systems", currentTitle: "Software Engineer",
    experienceYears: "4", consent: true, resume: { name: "Neha Gupta resume.pdf", bytes: nehaCv },
  }, new Date(Date.now() - 30 * HOUR)));
  const ravi = await add(backend, { first: "Ravi", last: "Kumar", email: "ravi.kumar@example.com", mobile: "9876501234", company: "Initech", title: "Backend Developer", years: 5, source: "job_board", tags: ["java", "backend"], skills: ["Java", "Spring", "Kubernetes"] });
  await move(ravi.applicationId!, "Screening");
  const ananya = await add(backend, { first: "Ananya", last: "Iyer", email: "ananya.iyer@example.com", mobile: "9845098450", company: "Umbrella Labs", title: "SDE II", years: 4, source: "agency", tags: ["go", "backend"], skills: ["Go", "PostgreSQL", "Docker"] });
  await move(ananya.applicationId!, "Technical round");
  const kabir = await add(backend, { first: "Kabir", last: "Shah", email: "kabir.shah@example.com", mobile: "9900112233", company: "Hooli", title: "Senior Engineer", years: 6, source: "manual", tags: ["python"], skills: ["Python", "Django", "AWS"] });
  await move(kabir.applicationId!, "Technical round");
  const zoya = await add(backend, { first: "Zoya", last: "Ahmed", email: "zoya.ahmed@example.com", mobile: "9811122233", company: "Vandelay", title: "Software Engineer", years: 3, source: "career_site", tags: ["node.js"], skills: ["TypeScript", "Node.js", "MongoDB"] });
  await move(zoya.applicationId!, "Manager round");
  const sid = await add(backend, { first: "Siddharth", last: "Menon", email: "siddharth.menon@example.com", mobile: "9822233344", company: "Stark Digital", title: "Senior Backend Engineer", years: 6, source: "manual", tags: ["java", "payments"], skills: ["Java", "Kafka", "AWS"] });
  await move(sid.applicationId!, "Manager round");
  const pooja = await add(backend, { first: "Pooja", last: "Reddy", email: "pooja.reddy@example.com", mobile: "9833344455", company: "Wayne Tech", title: "QA Engineer", years: 2, source: "job_board", tags: ["testing"] });
  await run((tx) => cands.rejectApplications(tx, aditya, [pooja.applicationId!], "Skills don't match", { sendEmail: true }));
  const tanviCv = await resumePdf("Tanvi Desai", "tanvi.desai@example.com", "9844455566", 5, ["PostgreSQL", "Python", "AWS"]);
  await run((tx) => internal.refer(tx, vikram, backend, { firstName: "Tanvi", lastName: "Desai", email: "tanvi.desai@example.com", mobile: "9844455566", note: "Worked with her at my last job; very strong on databases.",
    resume: { name: "Tanvi Desai resume.pdf", bytes: tanviCv } }));
  const rahul = await add(ae.id, { first: "Rahul", last: "Verma", email: "rahul.verma@example.com", mobile: "9855566677", company: "Acme Rivals", title: "Sales Executive", years: 3, source: "job_board", tags: ["b2b sales"] });
  await move(rahul.applicationId!, "Screening");
  const meghna = await add(ae.id, { first: "Meghna", last: "Das", email: "meghna.das@example.com", mobile: "9866677788", company: "Soylent", title: "Account Manager", years: 4, source: "agency", tags: ["b2b sales", "saas"] });
  await move(meghna.applicationId!, "Technical round");
  await run((tx) => internal.applyInternal(tx, fatima, csm.id, "I've handled vendor accounts for two years and would love to work with customers."));
  await run((tx) => cands.createCandidate(tx, aditya, { firstName: "Vivek", lastName: "Nair", email: "vivek.nair@example.com", mobile: "9877788899", gender: null, currentCompany: "Massive Dynamic", currentTitle: "Staff Engineer",
    experienceMonths: 108, source: "agency", tags: ["java", "backend", "talent pool"], custom: {} }));

  // ---------- interviews and feedback ----------
  const at = (dayOffset: number, hhmm: string) => new Date(`${addDaysISO(today, dayOffset)}T${hhmm}:00+05:30`);
  await run((tx) => iv.scheduleInterview(tx, aditya, ananya.applicationId!, { title: "Technical round", mode: "online", scheduling: "fixed", start: at(1, "11:00").toISOString(), end: at(1, "12:00").toISOString(),
    meetingUrl: "https://meet.example.com/acme-ananya", panel: [arjun.employeeId, meera.employeeId], scorecardId: ids.scorecard, notifyCandidate: true }));
  const past = await run((tx) => iv.scheduleInterview(tx, aditya, kabir.applicationId!, { title: "Technical round", mode: "in_person", scheduling: "fixed", start: at(-1, "15:00").toISOString(), end: at(-1, "16:00").toISOString(),
    location: "Head office, meeting room 2", panel: [arjun.employeeId, meera.employeeId], scorecardId: ids.scorecard, notifyCandidate: false }, new Date(at(-1, "10:00"))));
  await run((tx) => iv.submitScorecard(tx, arjun, past.interviewId, { ratings: { problem_solving: 4, domain: 4, communication: 3, ownership: 4 }, overall: null, recommendation: "yes", comments: "Solid on system design, a little quiet when explaining trade-offs." }));
  await run((tx) => iv.submitScorecard(tx, meera, past.interviewId, { ratings: { problem_solving: 5, domain: 4, communication: 4, ownership: 4 }, overall: null, recommendation: "strong_yes", comments: "Best debugging exercise this quarter." }));
  await move(kabir.applicationId!, "Manager round");
  await run((tx) => cands.addNote(tx, rohan, kabir.candidateId, { body: "Strong feedback from both panelists. I'll take the manager round this week.", applicationId: kabir.applicationId, isPrivate: false }));
  await run((tx) => iv.scheduleInterview(tx, aditya, ravi.applicationId!, { title: "Screening call", mode: "phone", scheduling: "self_schedule",
    slots: [{ start: at(2, "10:00").toISOString(), end: at(2, "10:30").toISOString() }, { start: at(2, "16:00").toISOString(), end: at(2, "16:30").toISOString() }, { start: at(3, "11:00").toISOString(), end: at(3, "11:30").toISOString() }],
    panel: [aditya.employeeId], scorecardId: ids.scorecard, notifyCandidate: true }));
  await run((tx) => iv.scheduleInterview(tx, aditya, meghna.applicationId!, { title: "Role play", mode: "online", scheduling: "fixed", start: at(2, "14:00").toISOString(), end: at(2, "15:00").toISOString(),
    meetingUrl: "https://meet.example.com/acme-meghna", panel: [sneha.employeeId, imran.employeeId], scorecardId: ids.scorecard, notifyCandidate: true }));

  // ---------- offers ----------
  const makeOffer = async (appId: string, ctc: number) => {
    const o = await run((tx) => offers.createOffer(tx, aditya, appId, { templateId: ids.offerTemplate, designationId: ids.swe, ctcPaise: ctc, joiningDate: addDaysISO(today, 30), expiresOn: addDaysISO(today, 7), note: null }));
    await run((tx) => offers.submitOffer(tx, aditya, o.id));
    await approveAll(o.id);
    const r = await run((tx) => offers.releaseOffer(tx, aditya, o.id));
    return { ...o, token: r.link.split("/p/portal/")[1] };
  };
  await makeOffer(zoya.applicationId!, 20_00_000_00);
  const sOffer = await makeOffer(sid.applicationId!, 26_50_000_00);
  await run(async (tx) => {
    await tx`update offers set otp_hash = ${sha256(`${sOffer.id}:246810`)}, otp_expires_at = now() + interval '10 minutes', otp_attempts = 0 where id = ${sOffer.id}`;
    const r = await offers.acceptOffer(tx, sOffer.token, { typedName: "Siddharth Menon", code: "246810", ip: "127.0.0.1" });
    if (!r.ok) throw new Error(r.error);
  });
  const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const docs = await run((tx) => tx<{ id: string; doc_type: string }[]>`select r.id, r.doc_type from document_requests r join candidates c on c.id = r.candidate_id where c.email = 'siddharth.menon@example.com' order by r.created_at`);
  for (const d of docs.slice(0, 3)) await run((tx) => offers.portalUpload(tx, sOffer.token, d.id, { name: `${d.doc_type}.pdf`, bytes: pdf }));
  await run((tx) => offers.reviewDocument(tx, priya, docs[0].id, "approved", null));
  await run((tx) => offers.reviewDocument(tx, priya, docs[1].id, "approved", null));
  const tasks = await run((tx) => tx<{ id: string }[]>`select t.id from preboarding_tasks t join candidates c on c.id = t.candidate_id where c.email = 'siddharth.menon@example.com' order by t.created_at`);
  await run((tx) => offers.portalTask(tx, sOffer.token, tasks[0].id, true));
  void asha;
}
