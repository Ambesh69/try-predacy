import PredacyMarketDetail from "@/components/PredacyMarketDetail";

interface Props {
  params: Promise<{ marketId: string }>;
}

export default function PredacyMarketPage({ params }: Props) {
  return <PredacyMarketDetail params={params} />;
}
