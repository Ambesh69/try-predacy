import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GAMMA_API = "https://gamma-api.polymarket.com";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const conditionId = searchParams.get("condition_id");
  const limit       = searchParams.get("limit") ?? "100";

  const url = conditionId
    ? `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}`
    : `${GAMMA_API}/markets?active=true&closed=false&limit=${limit}&order=volumeNum&ascending=false`;

  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Gamma API error" }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch markets" }, { status: 500 });
  }
}
