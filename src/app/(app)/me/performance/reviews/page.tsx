import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { myReviews } from "@/server/modules/performance/reviews";
import { peopleOptions } from "@/server/modules/performance/access";
import { MyReviews } from "@/features/performance/my-reviews";

export const metadata: Metadata = { title: "Reviews" };

export default async function ReviewsPage(props: PageProps<"/me/performance/reviews">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const [r, people] = await Promise.all([myReviews(tx, actor), peopleOptions(tx)]);
    return { ...r, people, me: actor.employeeId };
  });
  return <MyReviews {...d} initialTab={typeof sp.tab === "string" ? sp.tab : "write"} />;
}
