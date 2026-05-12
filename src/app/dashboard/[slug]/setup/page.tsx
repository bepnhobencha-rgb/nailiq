import { redirect } from "next/navigation";

type Props = { params: Promise<{ slug: string }> };

export default async function SetupIndexPage({ params }: Props) {
  const { slug } = await params;
  redirect(`/dashboard/${slug}/setup/services`);
}
