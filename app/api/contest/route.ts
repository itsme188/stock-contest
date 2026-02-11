import { NextResponse } from "next/server";
import { getContestData, saveContestData } from "@/lib/db";

export async function GET() {
  try {
    const data = getContestData();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to load data: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const data = await request.json();
    saveContestData(data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to save data: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
