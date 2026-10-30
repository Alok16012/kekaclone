import "server-only";
import type { Tx } from "@/server/db";
import type { ComponentKind } from "./rules";

type Def = { code: string; name: string; kind: ComponentKind; taxable?: boolean; taxSection?: string; lop?: boolean; pfWage?: boolean; esiWage?: boolean; payslip?: boolean; arrears?: boolean };

/**
 * Starter components. The statutory ones (PF, ESI, PT, LWF, TDS) are placeholders that payroll fills in from the
 * versioned statutory_rates table; their amounts are never hard-coded here.
 */
export const DEFAULT_COMPONENTS: Def[] = [
  { code: "BASIC", name: "Basic", kind: "earning", pfWage: true },
  { code: "HRA", name: "House rent allowance", kind: "earning", taxSection: "10(13A)" },
  { code: "SPECIAL", name: "Special allowance", kind: "earning" },
  { code: "PF_EMPLOYER", name: "PF (employer share)", kind: "employer_contribution", taxable: false, esiWage: false, lop: true },
  { code: "PF_EMPLOYEE", name: "PF (employee share)", kind: "deduction", taxable: false, esiWage: false },
  { code: "ESI", name: "ESI (employee share)", kind: "deduction", taxable: false, esiWage: false },
  { code: "PT", name: "Professional tax", kind: "deduction", taxable: false, esiWage: false, arrears: false },
  { code: "LWF", name: "Labour welfare fund", kind: "deduction", taxable: false, esiWage: false, lop: false, arrears: false },
  { code: "TDS", name: "Income tax (TDS)", kind: "deduction", taxable: false, esiWage: false, lop: false, arrears: false },
];

/**
 * Default structure lines. PF_EMPLOYER uses 12% of Basic capped at a ₹15,000 wage — a commonly quoted rule that erp has
 * NOT verified. It's an ordinary, editable formula on the tenant's structure; payroll screens warn until a CA signs off.
 */
export const DEFAULT_STRUCTURE = [
  { code: "BASIC", calc: "pct_ctc", value: "50", formula: null },
  { code: "HRA", calc: "formula", value: null, formula: "[BASIC] * 0.4" },
  { code: "PF_EMPLOYER", calc: "formula", value: null, formula: "min([BASIC], 15000) * 0.12" },
  { code: "SPECIAL", calc: "balancing", value: null, formula: null },
] as const;

/** Components, a "Monthly" pay group for the first legal entity and a "Standard" structure. Idempotent. */
export async function ensurePayrollDefaults(tx: Tx, tenantId: string) {
  for (const c of DEFAULT_COMPONENTS) {
    await tx`insert into salary_components (tenant_id, code, name, kind, is_taxable, tax_section, lop_prorated, pf_wage, esi_wage, on_payslip, in_arrears)
             values (${tenantId}, ${c.code}, ${c.name}, ${c.kind}, ${c.taxable ?? true}, ${c.taxSection ?? null}, ${c.lop ?? true}, ${c.pfWage ?? false}, ${c.esiWage ?? true}, ${c.payslip ?? true}, ${c.arrears ?? true})
             on conflict (tenant_id, code) do nothing`;
  }
  const [le] = await tx<{ id: string }[]>`select id from legal_entities order by created_at limit 1`;
  if (!le) return null;
  await tx`insert into pay_groups (tenant_id, legal_entity_id, name) values (${tenantId}, ${le.id}, 'Monthly') on conflict (tenant_id, name) do nothing`;
  const [g] = await tx<{ id: string }[]>`select id from pay_groups where name = 'Monthly'`;
  const [s] = await tx<{ id: string }[]>`insert into salary_structures (tenant_id, pay_group_id, name) values (${tenantId}, ${g.id}, 'Standard') on conflict (pay_group_id, name) do nothing returning id`;
  if (s) {
    for (const [i, l] of DEFAULT_STRUCTURE.entries()) {
      await tx`insert into salary_structure_lines (tenant_id, structure_id, component_id, calc, value, formula, position)
               select ${tenantId}, ${s.id}, id, ${l.calc}, ${l.value}, ${l.formula}, ${i} from salary_components where code = ${l.code}`;
    }
  }
  const [st] = await tx<{ id: string }[]>`select id from salary_structures where pay_group_id = ${g.id} and name = 'Standard'`;
  return { payGroupId: g.id, structureId: st.id };
}
