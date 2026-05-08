import { NextResponse } from "next/server";
import { listRecentEmailSends } from "@/lib/db";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(1, Math.min(100, parseInt(limitParam, 10) || 10)) : 10;
    const sends = listRecentEmailSends(limit);
    return NextResponse.json({ ok: true, sends });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to list email sends: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
