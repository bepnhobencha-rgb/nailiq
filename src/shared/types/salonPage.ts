export type SectionType = 'hero' | 'services' | 'about' | 'gallery' | 'promotions' | 'contact' | 'blog';

export interface SalonSection {
  id: string;
  salon_id: string;
  type: SectionType;
  title: string;
  is_visible: boolean;
  sort_order: number;
  content: Record<string, unknown>;
  updated_at: string;
}

export interface HeroContent { heading: string; subheading: string; cta_text: string; bg_image_url?: string | null; }
export interface ServicesContent { section_title: string; description?: string; show_price: 'full' | 'from-price' | 'hidden'; display_count: 'all' | '3' | '6'; }
export interface AboutContent { section_title: string; body: string; image_url?: string | null; layout: 'image-left' | 'image-right' | 'image-top'; }
export interface GalleryContent { section_title: string; images: { url: string; alt?: string }[]; grid_style: '3-col' | '2-col' | 'masonry' | 'slideshow'; }
export interface PromotionsContent { section_title: string; body: string; expires_at?: string | null; bg_style: 'brand' | 'dark' | 'light'; }
export interface ContactContent { address?: string; phone?: string; email?: string; show_map: boolean; }
export interface BlogContent { section_title: string; post_count: 3 | 6; }
