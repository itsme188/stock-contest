import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold text-gray-900">
          Stock Picking Contest
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          Track stock picks and performance for Daddy, Eli, and Yitzi.
        </p>
        <Link
          className="mt-6 inline-flex items-center rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50"
          href="/dashboard"
        >
          Go to Dashboard
        </Link>
      </div>
    </main>
  );
}
