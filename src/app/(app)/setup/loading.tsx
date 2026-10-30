import { Skeleton } from "@/ui/feedback";

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading company setup" className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-8 rounded-md" />
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}
