import "@rainbow-me/rainbowkit/styles.css";
import { Analytics } from "@vercel/analytics/react";
import { ScaffoldEthAppWithProviders } from "~~/components/ScaffoldEthAppWithProviders";
import { ThemeProvider } from "~~/components/ThemeProvider";
import "~~/styles/globals.css";
import { getMetadata } from "~~/utils/scaffold-eth/getMetadata";

export const metadata = getMetadata({
  title: "Roboshare",
  description:
    "Agent-supervised programmable credit rails for asset-backed finance, lender review, and downstream distribution.",
});

const shouldEnableAnalytics =
  process.env.NEXT_PUBLIC_ENABLE_VERCEL_ANALYTICS === "true" || process.env.VERCEL_ENV === "production";

const ScaffoldEthApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html suppressHydrationWarning>
      <body>
        <ThemeProvider enableSystem>
          <ScaffoldEthAppWithProviders>{children}</ScaffoldEthAppWithProviders>
        </ThemeProvider>
        {shouldEnableAnalytics && <Analytics />}
      </body>
    </html>
  );
};

export default ScaffoldEthApp;
