import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading loans" className="flex flex-col gap-6">
      <div><Skeleton className="h-8 w-48" /><Skeleton className="mt-2 h-4 w-80 max-w-full" /></div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3"><Skeleton className="h-24 rounded-lg" /><Skeleton className="h-24 rounded-lg" /><Skeleton className="h-24 rounded-lg" /></div>
      <Skeleton className="h-10 w-72 max-w-full" />
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
