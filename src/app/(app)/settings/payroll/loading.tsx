import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading payroll settings" className="flex flex-col gap-3">
      <Skeleton className="h-16 rounded-lg" />
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
    </div>
  );
}
