import type { personAssets, RequestRow } from "@/server/modules/assets/service";
import type { PersonAssetsDTO, RequestDTO } from "./types";

type PersonAssets = NonNullable<Awaited<ReturnType<typeof personAssets>>>;

export const toRequestDTO = (r: RequestRow & { mine?: boolean }): RequestDTO => ({
  id: r.id, employee_id: r.employee_id, employee: r.employee, type_id: r.type_id, type: r.type, category: r.category, kind: r.kind, reason: r.reason,
  status: r.status, created_at: r.created_at.toISOString(), available: r.available, mine: r.mine,
});

export function toPersonAssetsDTO(d: PersonAssets): PersonAssetsDTO {
  return {
    isSelf: d.isSelf, canManage: d.canManage,
    open: d.open.map((o) => ({ id: o.id, tag: o.tag, name: o.name, type: o.type, category: o.category, serial_number: o.serial_number, assigned_at: o.assigned_at.toISOString(), acknowledged_at: o.acknowledged_at?.toISOString() ?? null, requires_ack: o.requires_ack })),
    history: d.history.map((h) => ({ id: h.id, tag: h.tag, asset: h.asset, type: h.type, assigned_at: h.assigned_at.toISOString(), returned_at: h.returned_at!.toISOString(), return_condition: h.return_condition, recovery_paise: h.recovery_paise.toString(), return_notes: h.return_notes })),
    requests: d.requests.map(toRequestDTO),
  };
}
