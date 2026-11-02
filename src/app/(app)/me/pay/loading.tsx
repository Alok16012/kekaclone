import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading your finances" className="flex flex-col gap-6">
      <div><Skeleton className="h-8 w-48" /><Skeleton className="mt-2 h-4 w-72 max-w-full" /></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
      <Skeleton className="h-72 rounded-lg" />
    </div>
  );
}
