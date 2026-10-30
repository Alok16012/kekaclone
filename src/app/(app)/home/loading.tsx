import { Skeleton } from "@/ui/feedback";
import { FeedSkeleton } from "@/features/engage/wall";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading Home" className="flex flex-col gap-6">
      <div><Skeleton className="h-4 w-40" /><Skeleton className="mt-2 h-8 w-64" /></div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-4 lg:col-start-2 lg:row-start-1"><Skeleton className="h-44 rounded-lg" /><Skeleton className="h-56 rounded-lg" /></div>
        <div className="flex flex-col gap-4 lg:col-start-1 lg:row-start-1"><Skeleton className="h-24 rounded-lg" /><Skeleton className="h-10 w-64" /><FeedSkeleton count={3} /></div>
      </div>
    </div>
  );
}
