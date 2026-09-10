import SessionsPage from "@/app/dashboard/[slug]/sessions/page";
export const dynamic = "force-dynamic";
export default function Page() { return <SessionsPage params={Promise.resolve({ slug: "qa-session-salon" })} />; }
