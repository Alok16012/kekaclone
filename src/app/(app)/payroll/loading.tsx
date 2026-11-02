import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading payroll" className="flex flex-col gap-6">
      <div><Skeleton className="h-8 w-48" /><Skeleton className="mt-2 h-4 w-80 max-w-full" /></div>
      <Skeleton className="h-16 rounded-lg" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2"><Skeleton className="h-56 rounded-lg" /><Skeleton className="h-56 rounded-lg" /></div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
