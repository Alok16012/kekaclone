import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading your attendance">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-2 h-4 w-64" />
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-48 rounded-lg" />
        <div className="grid grid-cols-2 gap-4 lg:col-span-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
      </div>
      <Skeleton className="mt-6 h-10 w-56" />
      <Skeleton className="mt-4 h-80 rounded-lg" />
    </div>
  );
}
