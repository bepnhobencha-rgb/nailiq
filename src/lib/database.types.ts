export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      booking_waitlist_entries: {
        Row: {
          booking_date: string
          client_name: string
          client_phone: string
          created_at: string
          id: string
          preferred_slot_label: string | null
          salon_id: string
          service_id: string
          source: string
          staff_id: string | null
        }
        Insert: {
          booking_date: string
          client_name: string
          client_phone: string
          created_at?: string
          id?: string
          preferred_slot_label?: string | null
          salon_id: string
          service_id: string
          source: string
          staff_id?: string | null
        }
        Update: {
          booking_date?: string
          client_name?: string
          client_phone?: string
          created_at?: string
          id?: string
          preferred_slot_label?: string | null
          salon_id?: string
          service_id?: string
          source?: string
          staff_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "booking_waitlist_entries_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_waitlist_entries_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_waitlist_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          addon_price_cents: number | null
          addon_service_id: string | null
          client_email: string | null
          client_name: string
          client_notes: string | null
          client_phone: string | null
          created_at: string | null
          end_time_utc: string | null
          id: string
          joined_queue_at: string | null
          party_size: number | null
          price_cents: number | null
          salon_id: string
          service_id: string
          source: string
          staff_id: string | null
          staff_request_note: string | null
          start_time_utc: string | null
          started_at: string | null
          status: string
          walkin_priority: string | null
          walkin_request_tags: Json | null
          walkin_source: string | null
        }
        Insert: {
          addon_price_cents?: number | null
          addon_service_id?: string | null
          client_email?: string | null
          client_name: string
          client_notes?: string | null
          client_phone?: string | null
          created_at?: string | null
          end_time_utc?: string | null
          id?: string
          joined_queue_at?: string | null
          party_size?: number | null
          price_cents?: number | null
          salon_id: string
          service_id: string
          source?: string
          staff_id?: string | null
          staff_request_note?: string | null
          start_time_utc?: string | null
          started_at?: string | null
          status?: string
          walkin_priority?: string | null
          walkin_request_tags?: Json | null
          walkin_source?: string | null
        }
        Update: {
          addon_price_cents?: number | null
          addon_service_id?: string | null
          client_email?: string | null
          client_name?: string
          client_notes?: string | null
          client_phone?: string | null
          created_at?: string | null
          end_time_utc?: string | null
          id?: string
          joined_queue_at?: string | null
          party_size?: number | null
          price_cents?: number | null
          salon_id?: string
          service_id?: string
          source?: string
          staff_id?: string | null
          staff_request_note?: string | null
          start_time_utc?: string | null
          started_at?: string | null
          status?: string
          walkin_priority?: string | null
          walkin_request_tags?: Json | null
          walkin_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bookings_addon_service_id_fkey"
            columns: ["addon_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      client_profiles: {
        Row: {
          created_at: string | null
          id: string
          last_service_date: string | null
          name: string | null
          phone: string
          preferred_staff_id: string | null
          visit_count: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          last_service_date?: string | null
          name?: string | null
          phone: string
          preferred_staff_id?: string | null
          visit_count?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          last_service_date?: string | null
          name?: string | null
          phone?: string
          preferred_staff_id?: string | null
          visit_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_profiles_preferred_staff_id_fkey"
            columns: ["preferred_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      otps: {
        Row: {
          code: string
          created_at: string | null
          expires_at: string
          id: string
          phone: string
        }
        Insert: {
          code: string
          created_at?: string | null
          expires_at: string
          id?: string
          phone: string
        }
        Update: {
          code?: string
          created_at?: string | null
          expires_at?: string
          id?: string
          phone?: string
        }
        Relationships: []
      }
      queue_entries: {
        Row: {
          arrived_at: string
          assigned_staff_id: string | null
          client_name: string
          client_notes: string | null
          client_phone: string
          completed_at: string | null
          created_at: string | null
          id: string
          price_cents: number | null
          requested_staff_id: string | null
          salon_id: string
          service_id: string
          started_at: string | null
          status: string
        }
        Insert: {
          arrived_at?: string
          assigned_staff_id?: string | null
          client_name: string
          client_notes?: string | null
          client_phone: string
          completed_at?: string | null
          created_at?: string | null
          id?: string
          price_cents?: number | null
          requested_staff_id?: string | null
          salon_id: string
          service_id: string
          started_at?: string | null
          status?: string
        }
        Update: {
          arrived_at?: string
          assigned_staff_id?: string | null
          client_name?: string
          client_notes?: string | null
          client_phone?: string
          completed_at?: string | null
          created_at?: string | null
          id?: string
          price_cents?: number | null
          requested_staff_id?: string | null
          salon_id?: string
          service_id?: string
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "queue_entries_assigned_staff_id_fkey"
            columns: ["assigned_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "queue_entries_requested_staff_id_fkey"
            columns: ["requested_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "queue_entries_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "queue_entries_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      register_completion_tokens: {
        Row: {
          created_at: string | null
          expires_at: string
          id: string
          phone: string
          token: string
        }
        Insert: {
          created_at?: string | null
          expires_at: string
          id?: string
          phone: string
          token: string
        }
        Update: {
          created_at?: string | null
          expires_at?: string
          id?: string
          phone?: string
          token?: string
        }
        Relationships: []
      }
      salon_members: {
        Row: {
          created_at: string | null
          id: string
          role: string
          salon_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role?: string
          salon_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: string
          salon_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "salon_members_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      salons: {
        Row: {
          address: string | null
          booking_closed_dates: Json
          created_at: string | null
          dashboard_modules: Json
          dashboard_preset: string
          email: string | null
          email_verified: boolean | null
          id: string
          name: string
          opening_hours: Json | null
          phone: string
          profile_complete: boolean | null
          salon_phone: string | null
          slug: string
          timezone: string
        }
        Insert: {
          address?: string | null
          booking_closed_dates?: Json
          created_at?: string | null
          dashboard_modules?: Json
          dashboard_preset?: string
          email?: string | null
          email_verified?: boolean | null
          id?: string
          name: string
          opening_hours?: Json | null
          phone: string
          profile_complete?: boolean | null
          salon_phone?: string | null
          slug: string
          timezone?: string
        }
        Update: {
          address?: string | null
          booking_closed_dates?: Json
          created_at?: string | null
          dashboard_modules?: Json
          dashboard_preset?: string
          email?: string | null
          email_verified?: boolean | null
          id?: string
          name?: string
          opening_hours?: Json | null
          phone?: string
          profile_complete?: boolean | null
          salon_phone?: string | null
          slug?: string
          timezone?: string
        }
        Relationships: []
      }
      services: {
        Row: {
          buffer_minutes: number
          created_at: string | null
          duration_minutes: number
          id: string
          name: string
          price_cents: number
          salon_id: string
        }
        Insert: {
          buffer_minutes?: number
          created_at?: string | null
          duration_minutes: number
          id?: string
          name: string
          price_cents: number
          salon_id: string
        }
        Update: {
          buffer_minutes?: number
          created_at?: string | null
          duration_minutes?: number
          id?: string
          name?: string
          price_cents?: number
          salon_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          created_at: string | null
          id: string
          job_role: string
          name: string
          salon_id: string
          status: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          job_role?: string
          name: string
          salon_id: string
          status?: string
        }
        Update: {
          created_at?: string | null
          id?: string
          job_role?: string
          name?: string
          salon_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_services: {
        Row: {
          created_at: string
          service_id: string
          staff_id: string
        }
        Insert: {
          created_at?: string
          service_id: string
          staff_id: string
        }
        Update: {
          created_at?: string
          service_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_services_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_queue_entry: {
        Args: {
          p_client_name: string
          p_client_notes?: string
          p_client_phone: string
          p_price_cents?: number
          p_requested_staff_id?: string
          p_salon_id: string
          p_service_id: string
        }
        Returns: Json
      }
      create_public_booking: {
        Args: {
          p_addon_price_cents?: number
          p_addon_service_id?: string
          p_client_email?: string
          p_client_name: string
          p_client_notes?: string
          p_client_phone: string
          p_end_time_utc: string
          p_price_cents?: number
          p_salon_id: string
          p_service_id: string
          p_staff_id: string
          p_start_time_utc: string
          p_status?: string
        }
        Returns: Json
      }
      create_public_waitlist_entry: {
        Args: {
          p_booking_date: string
          p_client_name: string
          p_client_phone: string
          p_preferred_slot_label: string
          p_salon_id: string
          p_service_id: string
          p_source: string
          p_staff_id: string
          p_client_email?: string | null
        }
        Returns: {
          id: string
        }[]
      }
      get_salon_queue: {
        Args: { p_salon_id: string }
        Returns: {
          arrived_at: string
          assigned_staff_id: string
          client_name: string
          client_phone: string
          estimated_wait_minutes: number
          id: string
          position_in_queue: number
          requested_staff_id: string
          requested_staff_name: string
          service_duration_minutes: number
          service_id: string
          service_name: string
          status: string
        }[]
      }
      public_booking_occupancy_for_range: {
        Args: { p_end: string; p_salon_id: string; p_start: string }
        Returns: {
          end_time_utc: string
          staff_id: string
          start_time_utc: string
        }[]
      }
      salon_has_staff_services: {
        Args: { p_salon_id: string }
        Returns: boolean
      }
      update_queue_entry_status: {
        Args: { p_assigned_staff_id?: string; p_id: string; p_status: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
