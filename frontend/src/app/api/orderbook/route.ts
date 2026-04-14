import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CLOB_API = "https://clob.polymarket.com";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokenId = searchParams.get("token_id");

  if (!tokenId) {
    return NextResponse.json({ error: "token_id required" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`,
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      return NextResponse.json({ error: "CLOB API error" }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch orderbook" }, { status: 500 });
  }
}
