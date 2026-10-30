import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canAdminExpenses } from "@/server/modules/expenses/access";
import { listPolicies } from "@/server/modules/expenses/admin";
import { ExpenseSettings } from "@/features/expenses/settings";

export const metadata: Metadata = { title: "Expense policies" };

export default async function ExpenseSettingsPage() {
  const d = await load(async (tx, actor) => {
    const canEdit = canAdminExpenses(actor);
    const [policies, people] = await Promise.all([
      listPolicies(tx),
      canEdit ? tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
        select e.id, e.display_name as name, d.title, dp.name as department from employees e left join designations d on d.id = e.designation_id
        left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by e.display_name` : Promise.resolve([]),
    ]);
    return { policies, people, canEdit };
  });
  return <ExpenseSettings {...d} />;
}
