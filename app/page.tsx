import { Suspense } from "react";
import ClientPage from "./client-page";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading…</div>}>
      <ClientPage />
    </Suspense>
  );
}
