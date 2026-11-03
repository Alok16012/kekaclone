import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { reviewDetail } from "@/server/modules/performance/reviews";
import { ReviewForm } from "@/features/performance/review-form";

export const metadata: Metadata = { title: "Review" };

export default async function ReviewPage(props: PageProps<"/me/performance/reviews/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load((tx, actor) => reviewDetail(tx, actor, id));
  if (!d) notFound();
  return <ReviewForm d={d} />;
}
