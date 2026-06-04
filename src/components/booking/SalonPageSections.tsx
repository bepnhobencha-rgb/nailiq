/**
 * Public renderer for the website-builder sections (`salon_page_sections`).
 *
 * Renders the salon's marketing sections full-width ABOVE the booking flow on
 * `/[slug]` when `public_sections_enabled` is on. Server-rendered, no new
 * animations, and styled entirely from the booking theme tokens
 * (`--booking-*`, `--salon-primary`) so it inherits the per-salon brand +
 * light/dark palette already set on the page wrapper.
 *
 * `blog` is intentionally skipped — there is no blog/posts data model yet.
 */
import type { SalonSection } from "@/shared/types/salonPage";
import { formatServicePrice, type Currency } from "@/shared/lib/currencyFormat";

type ServiceLike = {
  id: string;
  name: string;
  durationMinutes?: number | null;
  priceCents?: number | null;
  priceType?: string | null;
  priceMaxCents?: number | null;
};

type Props = {
  sections: SalonSection[];
  services: ServiceLike[];
  currency: Currency;
  lang: "vi" | "en";
  salonName: string;
  salonAddress: string | null;
  salonPhone: string | null;
};

const BOOK_ANCHOR = "#book";

export function SalonPageSections({
  sections,
  services,
  currency,
  lang,
  salonName,
  salonAddress,
  salonPhone,
}: Props) {
  const vi = lang === "vi";
  const bookLabel = vi ? "Đặt lịch ngay" : "Book now";

  const rendered = sections
    .map((s) => {
      switch (s.type) {
        case "hero":
          return <HeroSection key={s.id} content={s.content} fallbackName={salonName} bookLabel={bookLabel} />;
        case "services":
          return <ServicesSection key={s.id} content={s.content} services={services} currency={currency} lang={lang} bookLabel={bookLabel} />;
        case "about":
          return <AboutSection key={s.id} content={s.content} />;
        case "gallery":
          return <GallerySection key={s.id} content={s.content} />;
        case "promotions":
          return <PromotionsSection key={s.id} content={s.content} />;
        case "contact":
          return <ContactSection key={s.id} content={s.content} lang={lang} fallbackAddress={salonAddress} fallbackPhone={salonPhone} />;
        case "blog":
        default:
          return null;
      }
    })
    .filter(Boolean);

  if (rendered.length === 0) return null;

  return (
    <div className="relative z-10 flex flex-col gap-16 px-4 pb-4 pt-8 sm:px-6 sm:pt-12 lg:px-8">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-16">{rendered}</div>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function str(content: Record<string, unknown>, key: string): string {
  const v = content?.[key];
  return typeof v === "string" ? v.trim() : "";
}

function ctaButton(label: string) {
  return (
    <a
      href={BOOK_ANCHOR}
      className="inline-flex items-center justify-center rounded-full bg-[var(--salon-primary)] px-6 py-3 text-sm font-semibold text-[var(--booking-bg)] shadow-sm transition-opacity hover:opacity-90"
    >
      {label}
    </a>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xl font-semibold tracking-tight text-[var(--booking-text)] sm:text-3xl">
      {children}
    </h2>
  );
}

// ── sections ─────────────────────────────────────────────────────────────

function HeroSection({
  content,
  fallbackName,
  bookLabel,
}: {
  content: Record<string, unknown>;
  fallbackName: string;
  bookLabel: string;
}) {
  const heading = str(content, "heading") || fallbackName;
  const subheading = str(content, "subheading");
  const cta = str(content, "cta_text") || bookLabel;
  const bg = str(content, "bg_image_url");

  return (
    <section className="relative overflow-hidden rounded-3xl border border-[var(--booking-border)]">
      {bg ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={bg} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--booking-bg)_55%,transparent)]" />
        </>
      ) : (
        <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--salon-primary)_10%,var(--booking-bg))]" />
      )}
      <div className="relative flex flex-col items-start gap-5 px-6 py-16 sm:px-12 sm:py-24">
        <h1 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-[var(--booking-text)] sm:text-5xl sm:leading-[1.1]">
          {heading}
        </h1>
        {subheading ? (
          <p className="max-w-xl text-pretty text-base text-[var(--booking-text-muted)] sm:text-lg">{subheading}</p>
        ) : null}
        {ctaButton(cta)}
      </div>
    </section>
  );
}

function ServicesSection({
  content,
  services,
  currency,
  lang,
  bookLabel,
}: {
  content: Record<string, unknown>;
  services: ServiceLike[];
  currency: Currency;
  lang: "vi" | "en";
  bookLabel: string;
}) {
  const title = str(content, "section_title") || (lang === "vi" ? "Dịch vụ" : "Our services");
  const description = str(content, "description");
  const show = (content?.["show_price"] as string) || "full";
  const countRaw = (content?.["display_count"] as string) || "all";
  const limit = countRaw === "3" ? 3 : countRaw === "6" ? 6 : services.length;
  const list = services.slice(0, limit);
  const fromLabel = lang === "vi" ? "Từ" : "From";

  return (
    <section className="flex flex-col gap-6">
      <SectionHeading>{title}</SectionHeading>
      {description ? (
        <p className="max-w-2xl text-pretty text-[var(--booking-text-muted)]">{description}</p>
      ) : null}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {list.map((s) => {
          const price =
            show === "hidden"
              ? null
              : formatServicePrice(s.priceCents ?? null, currency, {
                  priceType: s.priceType ?? undefined,
                  priceMaxCents: s.priceMaxCents ?? undefined,
                  fromLabel: show === "from-price" ? fromLabel : undefined,
                });
          return (
            <li
              key={s.id}
              className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-[var(--booking-text)]">{s.name}</p>
                {s.durationMinutes ? (
                  <p className="text-xs text-[var(--booking-text-muted)]">{s.durationMinutes} min</p>
                ) : null}
              </div>
              {price ? (
                <span className="shrink-0 font-semibold text-[var(--salon-primary)]">{price}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div>{ctaButton(bookLabel)}</div>
    </section>
  );
}

function AboutSection({ content }: { content: Record<string, unknown> }) {
  const title = str(content, "section_title");
  const body = str(content, "body");
  const image = str(content, "image_url");
  const layout = (content?.["layout"] as string) || "image-left";
  if (!title && !body && !image) return null;

  const text = (
    <div className="flex flex-col gap-4">
      {title ? <SectionHeading>{title}</SectionHeading> : null}
      {body ? (
        <p className="whitespace-pre-line text-pretty leading-relaxed text-[var(--booking-text-muted)]">{body}</p>
      ) : null}
    </div>
  );
  const img = image ? (
    <div className="overflow-hidden rounded-2xl border border-[var(--booking-border)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} alt={title || ""} className="h-full w-full object-cover" />
    </div>
  ) : null;

  if (layout === "image-top") {
    return (
      <section className="flex flex-col gap-6">
        {img}
        {text}
      </section>
    );
  }
  return (
    <section className="grid grid-cols-1 items-center gap-8 md:grid-cols-2">
      {layout === "image-right" ? (
        <>
          {text}
          {img}
        </>
      ) : (
        <>
          {img}
          {text}
        </>
      )}
    </section>
  );
}

function GallerySection({ content }: { content: Record<string, unknown> }) {
  const title = str(content, "section_title");
  const images = Array.isArray(content?.["images"])
    ? (content["images"] as { url?: string; alt?: string }[]).filter((i) => i?.url)
    : [];
  if (images.length === 0) return null;
  const grid = (content?.["grid_style"] as string) || "3-col";
  const cols = grid === "2-col" ? "sm:grid-cols-2" : "sm:grid-cols-3";

  return (
    <section className="flex flex-col gap-6">
      {title ? <SectionHeading>{title}</SectionHeading> : null}
      <div className={`grid grid-cols-2 gap-3 ${cols}`}>
        {images.map((im, i) => (
          <div key={i} className="aspect-square overflow-hidden rounded-2xl border border-[var(--booking-border)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={im.url} alt={im.alt || ""} loading="lazy" className="h-full w-full object-cover" />
          </div>
        ))}
      </div>
    </section>
  );
}

function PromotionsSection({ content }: { content: Record<string, unknown> }) {
  const title = str(content, "section_title");
  const body = str(content, "body");
  if (!title && !body) return null;
  const bg = (content?.["bg_style"] as string) || "brand";
  const bgClass =
    bg === "brand"
      ? "bg-[color-mix(in_srgb,var(--salon-primary)_14%,var(--booking-bg))] border-[color-mix(in_srgb,var(--salon-primary)_30%,transparent)]"
      : bg === "light"
        ? "bg-[var(--booking-bg-card)] border-[var(--booking-border)]"
        : "bg-[color-mix(in_srgb,#000_30%,var(--booking-bg))] border-[var(--booking-border)]";

  return (
    <section className={`flex flex-col items-start gap-3 rounded-3xl border px-6 py-10 sm:px-10 ${bgClass}`}>
      {title ? <SectionHeading>{title}</SectionHeading> : null}
      {body ? <p className="text-pretty text-[var(--booking-text-muted)]">{body}</p> : null}
    </section>
  );
}

function ContactSection({
  content,
  lang,
  fallbackAddress,
  fallbackPhone,
}: {
  content: Record<string, unknown>;
  lang: "vi" | "en";
  fallbackAddress: string | null;
  fallbackPhone: string | null;
}) {
  const address = str(content, "address") || fallbackAddress || "";
  const phone = str(content, "phone") || fallbackPhone || "";
  const email = str(content, "email");
  if (!address && !phone && !email) return null;
  const title = lang === "vi" ? "Liên hệ" : "Contact";

  return (
    <section className="flex flex-col gap-4">
      <SectionHeading>{title}</SectionHeading>
      <div className="flex flex-col gap-2 text-[var(--booking-text-muted)]">
        {address ? <p>{address}</p> : null}
        {phone ? (
          <a href={`tel:${phone.replace(/\s+/g, "")}`} className="text-[var(--salon-primary)] hover:underline">
            {phone}
          </a>
        ) : null}
        {email ? (
          <a href={`mailto:${email}`} className="text-[var(--salon-primary)] hover:underline">
            {email}
          </a>
        ) : null}
      </div>
    </section>
  );
}
