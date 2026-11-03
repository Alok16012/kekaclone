import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading" className="flex flex-col gap-4">
      <Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-80" />
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
    </div>
  );
}
