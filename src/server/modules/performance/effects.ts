import "server-only";
// Approval engine hook (kept tiny so the approvals service doesn't pull the whole performance module).
export { onCompProposalDecided } from "./compensation";
