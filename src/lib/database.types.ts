// Auto-generated types from Supabase
// Regenerate with: npx supabase gen types typescript --local > src/lib/database.types.ts
// (Requires Docker running)

export type Json =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: Json | undefined }
  | readonly Json[]

export type Database = {
  public: {
    Tables: {
      salons: {
        Row: {
          id: string
          name: string
          slug: string
          phone: string
          email: string | null
          address: string | null
          timezone: string
          dashboard_modules: unknown | null
          dashboard_preset: string | null
          dashboard_density: unknown | null
          currency_code: unknown | null
          walkin_auto_assign: boolean | null
          queue_display_mode: string | null
          subscription_plan: string
          plan_override: string | null
          feature_flags: Json
          // NOTE: basic_mode_forced added in migration but requires Docker to regenerate types
          // Use (salonData as any).basic_mode_forced in code until types are regenerated
          [key: string]: any
        }
        Insert: {
          [key: string]: any
        }
        Update: {
          [key: string]: any
        }
      }
      salon_members: {
        Row: {
          id: string
          salon_id: string
          user_id: string
          role: string
          created_at: string | null
          [key: string]: any
        }
        Insert: {
          [key: string]: any
        }
        Update: {
          [key: string]: any
        }
      }
      ai_trend_cache: {
        Row: {
          id: string
          salon_id: string
          period: string
          trends: Json
          created_at: string | null
          [key: string]: any
        }
        Insert: {
          [key: string]: any
        }
        Update: {
          [key: string]: any
        }
      }
      [key: string]: any
    }
    Views: {
      [key: string]: any
    }
    Functions: {
      [key: string]: any
    }
    Enums: {
      [key: string]: any
    }
    CompositeTypes: {
      [key: string]: any
    }
  }
}
