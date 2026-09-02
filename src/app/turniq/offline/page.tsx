import type { Metadata } from "next";

import { TurnIqOfflineConsole } from "./TurnIqOfflineConsole";

export const metadata: Metadata = {
  title: "TurnIQ Offline | NailIQ",
  robots: { index: false, follow: false },
};

export default function TurnIqOfflinePage() {
  return <TurnIqOfflineConsole />;
}
