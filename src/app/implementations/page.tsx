import { permanentRedirect } from "next/navigation";

export default function LegacyImplementationsPage() {
  permanentRedirect("/applications");
}
