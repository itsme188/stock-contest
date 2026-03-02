import { NextResponse } from "next/server";
import { deleteTrade } from "@/lib/db";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const deleted = deleteTrade(id);
    if (!deleted) {
      return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to delete trade: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
