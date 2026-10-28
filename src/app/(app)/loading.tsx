import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading page">
      <Skeleton className="h-8 w-60" />
      <Skeleton className="mt-2 h-4 w-80" />
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Skeleton className="h-44 rounded-lg" /><Skeleton className="h-44 rounded-lg md:col-span-2" />
        <Skeleton className="h-64 rounded-lg md:col-span-3" />
      </div>
    </div>
  );
}
