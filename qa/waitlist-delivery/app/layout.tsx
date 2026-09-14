import "@/app/globals.css";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-dvh bg-nq-bg text-nq-foreground">{children}</body>
    </html>
  );
}
