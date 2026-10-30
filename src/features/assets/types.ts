/** Plain data shapes for the asset screens (dates as ISO strings, money as paise strings). */
import type { AssetStatus, Condition, RequestStatus } from "@/server/modules/assets/rules";

export type AssetDTO = {
  id: string; tag: string; name: string; serial_number: string | null; condition: Condition; status: AssetStatus; purchase_date: string | null; cost_paise: string | null;
  type_id: string; type: string; category: string; requires_ack: boolean;
  assignment_id: string | null; holder_id: string | null; holder: string | null; assigned_at: string | null; acknowledged_at: string | null;
  /** may the viewer take this back (holder in their scope, not themselves)? */
  can_return: boolean;
};

export type TypeDTO = { id: string; category_id: string; name: string; requires_ack: boolean; requestable: boolean; total: number; available: number };
export type CategoryDTO = { id: string; name: string; types: TypeDTO[] };

export type RequestDTO = {
  id: string; employee_id: string; employee: string; type_id: string; type: string; category: string; kind: "new" | "replacement"; reason: string | null;
  status: RequestStatus; created_at: string; available: number; mine?: boolean;
};

export type HoldingDTO = { id: string; tag: string; name: string; type: string; category: string; serial_number: string | null; assigned_at: string; acknowledged_at: string | null; requires_ack: boolean };
export type ReturnedDTO = { id: string; tag: string; asset: string; type: string; assigned_at: string; returned_at: string; return_condition: Condition | null; recovery_paise: string; return_notes: string | null };
export type PersonAssetsDTO = { open: HoldingDTO[]; history: ReturnedDTO[]; requests: RequestDTO[]; isSelf: boolean; canManage: boolean };
