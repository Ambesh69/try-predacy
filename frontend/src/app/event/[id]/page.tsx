import EventPageClient from "@/components/EventPageClient";

interface Props {
  params: Promise<{ id: string }>;
}

export default function EventPage({ params }: Props) {
  return <EventPageClient params={params} />;
}
