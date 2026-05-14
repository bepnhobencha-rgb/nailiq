import type { Metadata } from "next";
import { ContactPageClient } from "@/components/contact/ContactPageClient";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with the NailIQ team in Vancouver, BC.",
};

export default function ContactPage() {
  return <ContactPageClient />;
}
