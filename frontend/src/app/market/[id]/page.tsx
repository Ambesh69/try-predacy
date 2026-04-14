import { MarketPageClient } from "@/components/MarketPageClient";

interface Props {
  params: Promise<{ id: string }>;
}

export default function MarketPage({ params }: Props) {
  return <MarketPageClient params={params} />;
}
