import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading" className="flex flex-col gap-4">
      <div><Skeleton className="h-8 w-56" /><Skeleton className="mt-2 h-4 w-80 max-w-full" /></div>
      <Skeleton className="h-10 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3"><Skeleton className="h-24 rounded-lg" /><Skeleton className="h-24 rounded-lg" /><Skeleton className="h-24 rounded-lg" /></div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
