import "@/app/globals.css";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body className="bg-nq-bg text-nq-foreground">{children}</body></html>;
}
