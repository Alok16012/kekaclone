import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading">
      <Skeleton className="h-8 w-56" /><Skeleton className="mt-2 h-4 w-80" />
      <Skeleton className="mt-6 h-10 w-72" />
      <div className="mt-6 flex flex-col gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
    </div>
  );
}
