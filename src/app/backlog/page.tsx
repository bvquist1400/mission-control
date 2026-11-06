import { Suspense } from "react";
import { BacklogList } from "@/components/backlog/BacklogList";

/** Tasks (redesign S5): the page header, filters, saved views and card rows are all in BacklogList. */
export default function BacklogPage() {
  return (
    <Suspense>
      <BacklogList />
    </Suspense>
  );
}
