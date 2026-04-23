"use client";

import React from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";

const solanaConnectors = toSolanaWalletConnectors({
  shouldAutoConnect: true,
});

export default function PrivyWrapper({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    return <>{children}</>;
  }

  return (
    <PrivyErrorBoundary fallback={children}>
      <PrivyProvider
        appId={appId}
        config={{
          // Anonymous Sign-in-with-Solana only — no email, social, or SMS.
          // Privy's only identifier for the user is the Solana public key.
          // No PII is collected at login time; nothing to subpoena beyond
          // what's already on-chain.
          loginMethods: ["wallet"],
          appearance: {
            theme: "dark",
            accentColor: "#2CE8C6" as `#${string}`,
            showWalletLoginFirst: true,
            walletChainType: "solana-only",
            walletList: ["phantom", "detected_solana_wallets"],
            landingHeader: "Connect to Predacy",
            loginMessage: "Trade without trace. Anonymous wallet connect — no email, no tracking.",
          },
          // No embedded wallets — users bring their own (Phantom / Backpack / etc).
          // Embedded wallets would tie a server-side key to the user session,
          // which we explicitly don't want for privacy.
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
