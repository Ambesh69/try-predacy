import PredacyEventDetail from "@/components/PredacyEventDetail";

interface Props {
  params: Promise<{ handleId: string }>;
}

export default function PredacyEventPage({ params }: Props) {
  return <PredacyEventDetail params={params} />;
}
