"use client";

import React from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";

const solanaConnectors = toSolanaWalletConnectors({
  shouldAutoConnect: true,
});

export default function PrivyWrapper({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  // Debug: log what the client actually receives
  console.log("[Predacy] PRIVY_APP_ID received:", JSON.stringify(appId), "length:", appId?.length);

  if (!appId) {
    console.warn("[Predacy] No NEXT_PUBLIC_PRIVY_APP_ID — wallet disabled");
    return <>{children}</>;
  }

  return (
    <PrivyErrorBoundary fallback={children}>
      <PrivyProvider
        appId={appId}
        config={{
          appearance: {
            theme: "dark",
            accentColor: "#2CE8C6" as `#${string}`,
            showWalletLoginFirst: true,
            walletChainType: "solana-only",
            walletList: ["phantom", "detected_solana_wallets"],
            landingHeader: "Connect to Predacy",
            loginMessage: "Trade without trace.",
          },
          loginMethods: ["wallet"],
          embeddedWallets: {
            solana: {
              createOnLogin: "off",
            },
          },
          externalWallets: {
            solana: {
              connectors: solanaConnectors,
            },
          },
        }}
      >
        {children}
      </PrivyProvider>
    </PrivyErrorBoundary>
  );
}

class PrivyErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.error("Privy provider error:", error);
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}
