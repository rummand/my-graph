import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="max-w-xl pt-6">
      <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">This file isn&apos;t here</h1>
      <p className="mt-2 text-muted">It may have been deleted, or the person who added it hasn&apos;t shared it with you.</p>
      <Link href="/library" className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
        <ArrowLeft aria-hidden className="size-4" />Back to the library
      </Link>
    </div>
  );
}
