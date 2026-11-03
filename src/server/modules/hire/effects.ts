import "server-only";
/** What happens when the approval engine finishes a requisition or an offer (both guarded on status, so repeats do nothing). */
export { onRequisitionDecided } from "./jobs";
export { onOfferDecided } from "./offers";
