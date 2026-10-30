import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading statutory rates" className="flex flex-col gap-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-16 rounded-md" />
      <Skeleton className="h-10 w-64" />
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-lg" />)}
    </div>
  );
}
