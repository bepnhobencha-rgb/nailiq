import { DigestBackfillCard } from "@/components/superadmin/DigestBackfillCard";
import { recoverSalonDigest } from "../mockAction";
export default function Page() {
  return <main className="mx-auto max-w-3xl p-4"><h1>Synthetic QA · No provider or database</h1>
    <DigestBackfillCard salonId="11111111-1111-4111-8111-111111111111" salonName="Synthetic Salon" recoverAction={recoverSalonDigest} />
  </main>;
}
