import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading the team calendar">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      <Skeleton className="mt-6 h-9 w-56" />
      <Skeleton className="mt-4 h-80 rounded-lg" />
    </div>
  );
}
