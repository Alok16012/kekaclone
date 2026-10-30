import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading your team">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-2 h-4 w-64" />
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
      <Skeleton className="mt-6 h-56 rounded-lg" />
      <Skeleton className="mt-6 h-72 rounded-lg" />
    </div>
  );
}
