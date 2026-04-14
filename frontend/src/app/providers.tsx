"use client";

import dynamic from "next/dynamic";

const PrivyWrapper = dynamic(() => import("./PrivyWrapper"), {
  ssr: false,
});

export function Providers({ children }: { children: React.ReactNode }) {
  return <PrivyWrapper>{children}</PrivyWrapper>;
}
