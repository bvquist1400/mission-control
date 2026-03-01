import { redirect } from "next/navigation";

export default function TriagePage() {
  redirect("/backlog?review=needs_review");
}
