import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading" className="flex flex-col gap-4">
      <div className="flex justify-between gap-3"><Skeleton className="h-9 w-64 max-w-full" /><Skeleton className="h-9 w-32" /></div>
      <Skeleton className="h-36 rounded-lg" /><Skeleton className="h-36 rounded-lg" /><Skeleton className="h-36 rounded-lg" />
    </div>
  );
}
