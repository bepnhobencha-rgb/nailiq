import { TurnIqCustomerCheckInCard } from "@/components/receptionist/TurnIqCustomerCheckInCard";

const SERVICE = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";

export type TurnIqM4lScenario = "booked" | "group" | "requested" | "walkin" | "offline" | "server";

export function TurnIqCustomerCheckInHarness({ scenario }: { scenario: TurnIqM4lScenario }) {
  return (
    <main className="min-h-screen bg-nq-bg p-4 sm:p-8">
      <div className="mx-auto max-w-md">
        <p className="mb-4 text-sm font-semibold text-nq-muted">
          Synthetic TurnIQ M4L local · no database, booking or provider calls
        </p>
        <TurnIqCustomerCheckInCard
          channel={scenario === "booked" || scenario === "group" || scenario === "server" ? "qr" : "kiosk"}
          visitKind={scenario === "walkin" ? "walkin" : "booked"}
          services={[{ id: SERVICE, name: "Classic Pedicure" }]}
          technicians={[{ id: STAFF, name: "Mai" }]}
          actorSessionFingerprint={"a".repeat(64)}
          defaultPartySize={scenario === "group" ? 4 : 1}
          defaultRequestedStaffId={scenario === "requested" ? STAFF : null}
          offline={scenario === "offline"}
          capabilityToken={scenario === "server" ? "99999999-9999-4999-8999-999999999999" : null}
          initialCommandId={scenario === "server" ? "88888888-8888-4888-8888-888888888888" : undefined}
          initialSubmittedAt={scenario === "server" ? "2026-09-02T18:00:00.000Z" : undefined}
        />
      </div>
    </main>
  );
}
