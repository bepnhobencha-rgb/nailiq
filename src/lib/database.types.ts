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
      ai_chats: {
        Row: {
          client_phone: string | null
          client_profile_id: string | null
          customer_helpful_at: string | null
          customer_helpful_rating: number | null
          deleted_at: string | null
          ended_at: string | null
          id: string
          language: string | null
          last_message_at: string
          message_count: number
          messages: Json
          resulting_booking_id: string | null
          resulting_waitlist_id: string | null
          salon_id: string
          session_id: string
          started_at: string
          status: string
          total_tokens_used: number
        }
        Insert: {
          client_phone?: string | null
          client_profile_id?: string | null
          customer_helpful_at?: string | null
          customer_helpful_rating?: number | null
          deleted_at?: string | null
          ended_at?: string | null
          id?: string
          language?: string | null
          last_message_at?: string
          message_count?: number
          messages?: Json
          resulting_booking_id?: string | null
          resulting_waitlist_id?: string | null
          salon_id: string
          session_id: string
          started_at?: string
          status?: string
          total_tokens_used?: number
        }
        Update: {
          client_phone?: string | null
          client_profile_id?: string | null
          customer_helpful_at?: string | null
          customer_helpful_rating?: number | null
          deleted_at?: string | null
          ended_at?: string | null
          id?: string
          language?: string | null
          last_message_at?: string
          message_count?: number
          messages?: Json
          resulting_booking_id?: string | null
          resulting_waitlist_id?: string | null
          salon_id?: string
          session_id?: string
          started_at?: string
          status?: string
          total_tokens_used?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_chats_client_profile_id_fkey"
            columns: ["client_profile_id"]
            isOneToOne: false
            referencedRelation: "client_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_chats_resulting_booking_id_fkey"
            columns: ["resulting_booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_chats_resulting_waitlist_id_fkey"
            columns: ["resulting_waitlist_id"]
            isOneToOne: false
            referencedRelation: "booking_waitlist_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_chats_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_trend_cache: {
        Row: {
          click_through_count: number
          computed_at: string
          computed_by: string | null
          created_at: string
          id: string
          next_refresh_at: string
          period: string
          salon_id: string
          served_count: number
          trend_count: number
          trends: Json
        }
        Insert: {
          click_through_count?: number
          computed_at?: string
          computed_by?: string | null
          created_at?: string
          id?: string
          next_refresh_at?: string
          period: string
          salon_id: string
          served_count?: number
          trend_count?: number
          trends?: Json
        }
        Update: {
          click_through_count?: number
          computed_at?: string
          computed_by?: string | null
          created_at?: string
          id?: string
          next_refresh_at?: string
          period?: string
          salon_id?: string
          served_count?: number
          trend_count?: number
          trends?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ai_trend_cache_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_upsell_log: {
        Row: {
          added_revenue_cents: number | null
          booking_id: string | null
          client_phone: string | null
          confidence_score: number | null
          created_at: string
          id: string
          outcome: string
          outcome_at: string | null
          salon_id: string
          session_id: string | null
          suggested_service_id: string
          suggestion_position: string
          suggestion_reason: string | null
        }
        Insert: {
          added_revenue_cents?: number | null
          booking_id?: string | null
          client_phone?: string | null
          confidence_score?: number | null
          created_at?: string
          id?: string
          outcome?: string
          outcome_at?: string | null
          salon_id: string
          session_id?: string | null
          suggested_service_id: string
          suggestion_position: string
          suggestion_reason?: string | null
        }
        Update: {
          added_revenue_cents?: number | null
          booking_id?: string | null
          client_phone?: string | null
          confidence_score?: number | null
          created_at?: string
          id?: string
          outcome?: string
          outcome_at?: string | null
          salon_id?: string
          session_id?: string | null
          suggested_service_id?: string
          suggestion_position?: string
          suggestion_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_upsell_log_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_upsell_log_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_upsell_log_suggested_service_id_fkey"
            columns: ["suggested_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_events: {
        Row: {
          actor_role: string
          actor_user_id: string | null
          booking_id: string
          created_at: string
          event_type: string
          id: string
          payload: Json | null
          salon_id: string
        }
        Insert: {
          actor_role: string
          actor_user_id?: string | null
          booking_id: string
          created_at?: string
          event_type: string
          id?: string
          payload?: Json | null
          salon_id: string
        }
        Update: {
          actor_role?: string
          actor_user_id?: string | null
          booking_id?: string
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json | null
          salon_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_events_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_notifications: {
        Row: {
          body_preview: string | null
          booking_id: string | null
          channel: string
          client_phone: string | null
          created_at: string
          delivered_at: string | null
          error_message: string | null
          failed_at: string | null
          id: string
          notification_type: string
          salon_id: string
          sent_at: string | null
          status: string
          twilio_message_sid: string | null
        }
        Insert: {
          body_preview?: string | null
          booking_id?: string | null
          channel?: string
          client_phone?: string | null
          created_at?: string
          delivered_at?: string | null
          error_message?: string | null
          failed_at?: string | null
          id?: string
          notification_type: string
          salon_id: string
          sent_at?: string | null
          status?: string
          twilio_message_sid?: string | null
        }
        Update: {
          body_preview?: string | null
          booking_id?: string | null
          channel?: string
          client_phone?: string | null
          created_at?: string
          delivered_at?: string | null
          error_message?: string | null
          failed_at?: string | null
          id?: string
          notification_type?: string
          salon_id?: string
          sent_at?: string | null
          status?: string
          twilio_message_sid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "booking_notifications_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_notifications_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_photos: {
        Row: {
          ai_detected_colors: string[] | null
          ai_detected_services: string[] | null
          ai_detected_style: string | null
          ai_processed_at: string | null
          ai_quality_score: number | null
          ai_tags: Json | null
          booking_id: string
          created_at: string
          customer_feedback: string | null
          customer_rated_at: string | null
          customer_rating: number | null
          customer_viewed_at: string | null
          deleted_at: string | null
          file_size_bytes: number | null
          height_px: number | null
          id: string
          manual_tags: string[] | null
          posted_at: string | null
          posted_to_instagram: boolean
          posted_to_website: boolean
          salon_id: string
          sms_sent_at: string | null
          staff_id: string | null
          storage_path: string
          thumbnail_path: string | null
          width_px: number | null
        }
        Insert: {
          ai_detected_colors?: string[] | null
          ai_detected_services?: string[] | null
          ai_detected_style?: string | null
          ai_processed_at?: string | null
          ai_quality_score?: number | null
          ai_tags?: Json | null
          booking_id: string
          created_at?: string
          customer_feedback?: string | null
          customer_rated_at?: string | null
          customer_rating?: number | null
          customer_viewed_at?: string | null
          deleted_at?: string | null
          file_size_bytes?: number | null
          height_px?: number | null
          id?: string
          manual_tags?: string[] | null
          posted_at?: string | null
          posted_to_instagram?: boolean
          posted_to_website?: boolean
          salon_id: string
          sms_sent_at?: string | null
          staff_id?: string | null
          storage_path: string
          thumbnail_path?: string | null
          width_px?: number | null
        }
        Update: {
          ai_detected_colors?: string[] | null
          ai_detected_services?: string[] | null
          ai_detected_style?: string | null
          ai_processed_at?: string | null
          ai_quality_score?: number | null
          ai_tags?: Json | null
          booking_id?: string
          created_at?: string
          customer_feedback?: string | null
          customer_rated_at?: string | null
          customer_rating?: number | null
          customer_viewed_at?: string | null
          deleted_at?: string | null
          file_size_bytes?: number | null
          height_px?: number | null
          id?: string
          manual_tags?: string[] | null
          posted_at?: string | null
          posted_to_instagram?: boolean
          posted_to_website?: boolean
          salon_id?: string
          sms_sent_at?: string | null
          staff_id?: string | null
          storage_path?: string
          thumbnail_path?: string | null
          width_px?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "booking_photos_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_photos_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_photos_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_reminder_tokens: {
        Row: {
          booking_id: string
          created_at: string
          expires_at: string
          id: string
          salon_id: string
          used_action: string | null
          used_at: string | null
        }
        Insert: {
          booking_id: string
          created_at?: string
          expires_at: string
          id?: string
          salon_id: string
          used_action?: string | null
          used_at?: string | null
        }
        Update: {
          booking_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          salon_id?: string
          used_action?: string | null
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "booking_reminder_tokens_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_reminder_tokens_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_waitlist_entries: {
        Row: {
          booking_date: string
          claim_token: string | null
          claimed_at: string | null
          client_email: string | null
          client_name: string
          client_phone: string
          created_at: string
          id: string
          notified_at: string | null
          preferred_slot_label: string | null
          salon_id: string
          service_id: string
          source: string
          staff_id: string | null
          status: string
        }
        Insert: {
          booking_date: string
          claim_token?: string | null
          claimed_at?: string | null
          client_email?: string | null
          client_name: string
          client_phone: string
          created_at?: string
          id?: string
          notified_at?: string | null
          preferred_slot_label?: string | null
          salon_id: string
          service_id: string
          source: string
          staff_id?: string | null
          status?: string
        }
        Update: {
          booking_date?: string
          claim_token?: string | null
          claimed_at?: string | null
          client_email?: string | null
          client_name?: string
          client_phone?: string
          created_at?: string
          id?: string
          notified_at?: string | null
          preferred_slot_label?: string | null
          salon_id?: string
          service_id?: string
          source?: string
          staff_id?: string | null
          status?: string
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
          confirmed_at: string | null
          created_at: string | null
          deleted_at: string | null
          deposit_amount_cents: number | null
          deposit_reason: string | null
          deposit_required: boolean
          deposit_status: string
          end_time_utc: string | null
          group_id: string | null
          group_size: number | null
          id: string
          idempotency_key: string | null
          joined_queue_at: string | null
          no_show_risk_score: number | null
          otp_session_id: string | null
          party_size: number | null
          price_cents: number | null
          reconfirm_sent_at: string | null
          reference_image_path: string | null
          reminder_24h_sent_at: string | null
          reminder_3h_sent_at: string | null
          rescheduled_at: string | null
          rescheduled_by: string | null
          rescheduled_from_time_utc: string | null
          salon_id: string
          service_combo_id: string | null
          service_id: string
          sms_confirmation_error: string | null
          sms_confirmation_failed_at: string | null
          sms_confirmation_sent_at: string | null
          soft_hold_until: string | null
          source: string
          staff_id: string | null
          staff_request_note: string | null
          staff_requested_by_client: boolean
          start_time_utc: string | null
          started_at: string | null
          status: string
          verification_completed_at: string | null
          verification_method: string | null
          walkin_priority: string | null
          walkin_request_tags: Json | null
          walkin_source: string | null
          wave_number: number
        }
        Insert: {
          addon_price_cents?: number | null
          addon_service_id?: string | null
          client_email?: string | null
          client_name: string
          client_notes?: string | null
          client_phone?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          deleted_at?: string | null
          deposit_amount_cents?: number | null
          deposit_reason?: string | null
          deposit_required?: boolean
          deposit_status?: string
          end_time_utc?: string | null
          group_id?: string | null
          group_size?: number | null
          id?: string
          idempotency_key?: string | null
          joined_queue_at?: string | null
          no_show_risk_score?: number | null
          otp_session_id?: string | null
          party_size?: number | null
          price_cents?: number | null
          reconfirm_sent_at?: string | null
          reference_image_path?: string | null
          reminder_24h_sent_at?: string | null
          reminder_3h_sent_at?: string | null
          rescheduled_at?: string | null
          rescheduled_by?: string | null
          rescheduled_from_time_utc?: string | null
          salon_id: string
          service_combo_id?: string | null
          service_id: string
          sms_confirmation_error?: string | null
          sms_confirmation_failed_at?: string | null
          sms_confirmation_sent_at?: string | null
          soft_hold_until?: string | null
          source?: string
          staff_id?: string | null
          staff_request_note?: string | null
          staff_requested_by_client?: boolean
          start_time_utc?: string | null
          started_at?: string | null
          status?: string
          verification_completed_at?: string | null
          verification_method?: string | null
          walkin_priority?: string | null
          walkin_request_tags?: Json | null
          walkin_source?: string | null
          wave_number?: number
        }
        Update: {
          addon_price_cents?: number | null
          addon_service_id?: string | null
          client_email?: string | null
          client_name?: string
          client_notes?: string | null
          client_phone?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          deleted_at?: string | null
          deposit_amount_cents?: number | null
          deposit_reason?: string | null
          deposit_required?: boolean
          deposit_status?: string
          end_time_utc?: string | null
          group_id?: string | null
          group_size?: number | null
          id?: string
          idempotency_key?: string | null
          joined_queue_at?: string | null
          no_show_risk_score?: number | null
          otp_session_id?: string | null
          party_size?: number | null
          price_cents?: number | null
          reconfirm_sent_at?: string | null
          reference_image_path?: string | null
          reminder_24h_sent_at?: string | null
          reminder_3h_sent_at?: string | null
          rescheduled_at?: string | null
          rescheduled_by?: string | null
          rescheduled_from_time_utc?: string | null
          salon_id?: string
          service_combo_id?: string | null
          service_id?: string
          sms_confirmation_error?: string | null
          sms_confirmation_failed_at?: string | null
          sms_confirmation_sent_at?: string | null
          soft_hold_until?: string | null
          source?: string
          staff_id?: string | null
          staff_request_note?: string | null
          staff_requested_by_client?: boolean
          start_time_utc?: string | null
          started_at?: string | null
          status?: string
          verification_completed_at?: string | null
          verification_method?: string | null
          walkin_priority?: string | null
          walkin_request_tags?: Json | null
          walkin_source?: string | null
          wave_number?: number
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
            foreignKeyName: "bookings_otp_session_id_fkey"
            columns: ["otp_session_id"]
            isOneToOne: false
            referencedRelation: "phone_otp_sessions"
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
            foreignKeyName: "bookings_service_combo_id_fkey"
            columns: ["service_combo_id"]
            isOneToOne: false
            referencedRelation: "service_combos"
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
          birthday: string | null
          birthday_voucher_sent_year: number | null
          created_at: string | null
          deleted_at: string | null
          email: string | null
          id: string
          is_vip: boolean
          last_service_date: string | null
          name: string | null
          no_show_count: number
          notes: string | null
          phone: string
          preferred_staff_id: string | null
          total_spent_cents: number
          updated_at: string
          visit_count: number | null
        }
        Insert: {
          birthday?: string | null
          birthday_voucher_sent_year?: number | null
          created_at?: string | null
          deleted_at?: string | null
          email?: string | null
          id?: string
          is_vip?: boolean
          last_service_date?: string | null
          name?: string | null
          no_show_count?: number
          notes?: string | null
          phone: string
          preferred_staff_id?: string | null
          total_spent_cents?: number
          updated_at?: string
          visit_count?: number | null
        }
        Update: {
          birthday?: string | null
          birthday_voucher_sent_year?: number | null
          created_at?: string | null
          deleted_at?: string | null
          email?: string | null
          id?: string
          is_vip?: boolean
          last_service_date?: string | null
          name?: string | null
          no_show_count?: number
          notes?: string | null
          phone?: string
          preferred_staff_id?: string | null
          total_spent_cents?: number
          updated_at?: string
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
      customer_booking_patterns: {
        Row: {
          bookings_analyzed: number
          client_phone: string
          client_profile_id: string | null
          created_at: string
          id: string
          last_booking_at: string | null
          last_computed_at: string
          next_predicted_at: string | null
          next_refresh_at: string
          pattern_confidence: number | null
          recurrence_frequency_days: number | null
          recurring_hour: number | null
          recurring_minute: number | null
          recurring_weekday: number | null
          salon_id: string
          updated_at: string
          usual_addon_service_id: string | null
          usual_service_ids: string[] | null
          usual_staff_id: string | null
          usual_total_cents: number | null
        }
        Insert: {
          bookings_analyzed?: number
          client_phone: string
          client_profile_id?: string | null
          created_at?: string
          id?: string
          last_booking_at?: string | null
          last_computed_at?: string
          next_predicted_at?: string | null
          next_refresh_at?: string
          pattern_confidence?: number | null
          recurrence_frequency_days?: number | null
          recurring_hour?: number | null
          recurring_minute?: number | null
          recurring_weekday?: number | null
          salon_id: string
          updated_at?: string
          usual_addon_service_id?: string | null
          usual_service_ids?: string[] | null
          usual_staff_id?: string | null
          usual_total_cents?: number | null
        }
        Update: {
          bookings_analyzed?: number
          client_phone?: string
          client_profile_id?: string | null
          created_at?: string
          id?: string
          last_booking_at?: string | null
          last_computed_at?: string
          next_predicted_at?: string | null
          next_refresh_at?: string
          pattern_confidence?: number | null
          recurrence_frequency_days?: number | null
          recurring_hour?: number | null
          recurring_minute?: number | null
          recurring_weekday?: number | null
          salon_id?: string
          updated_at?: string
          usual_addon_service_id?: string | null
          usual_service_ids?: string[] | null
          usual_staff_id?: string | null
          usual_total_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_booking_patterns_client_profile_id_fkey"
            columns: ["client_profile_id"]
            isOneToOne: false
            referencedRelation: "client_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_booking_patterns_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_booking_patterns_usual_addon_service_id_fkey"
            columns: ["usual_addon_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_booking_patterns_usual_staff_id_fkey"
            columns: ["usual_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_photo_consents: {
        Row: {
          client_phone: string
          client_profile_id: string | null
          consent_receive_sms: boolean
          consent_save_to_profile: boolean
          consent_share_public: boolean
          consent_use_marketing: boolean
          granted_at: string
          granted_by_staff_id: string | null
          granted_via: string
          id: string
          revoked_at: string | null
          revoked_reason: string | null
          salon_id: string
          updated_at: string
        }
        Insert: {
          client_phone: string
          client_profile_id?: string | null
          consent_receive_sms?: boolean
          consent_save_to_profile?: boolean
          consent_share_public?: boolean
          consent_use_marketing?: boolean
          granted_at?: string
          granted_by_staff_id?: string | null
          granted_via?: string
          id?: string
          revoked_at?: string | null
          revoked_reason?: string | null
          salon_id: string
          updated_at?: string
        }
        Update: {
          client_phone?: string
          client_profile_id?: string | null
          consent_receive_sms?: boolean
          consent_save_to_profile?: boolean
          consent_share_public?: boolean
          consent_use_marketing?: boolean
          granted_at?: string
          granted_by_staff_id?: string | null
          granted_via?: string
          id?: string
          revoked_at?: string | null
          revoked_reason?: string | null
          salon_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_photo_consents_client_profile_id_fkey"
            columns: ["client_profile_id"]
            isOneToOne: false
            referencedRelation: "client_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_photo_consents_granted_by_staff_id_fkey"
            columns: ["granted_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_photo_consents_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_preferences: {
        Row: {
          allergies: string[] | null
          client_profile_id: string
          consent_ai_personalization: boolean
          consent_marketing_email: boolean
          consent_marketing_sms: boolean
          created_at: string
          extra: Json
          favorite_colors: string[] | null
          favorite_styles: string[] | null
          last_updated_by: string | null
          preferred_communication_channel: string | null
          preferred_language: string | null
          preferred_sms_time_window: string | null
          salon_id: string
          updated_at: string
        }
        Insert: {
          allergies?: string[] | null
          client_profile_id: string
          consent_ai_personalization?: boolean
          consent_marketing_email?: boolean
          consent_marketing_sms?: boolean
          created_at?: string
          extra?: Json
          favorite_colors?: string[] | null
          favorite_styles?: string[] | null
          last_updated_by?: string | null
          preferred_communication_channel?: string | null
          preferred_language?: string | null
          preferred_sms_time_window?: string | null
          salon_id: string
          updated_at?: string
        }
        Update: {
          allergies?: string[] | null
          client_profile_id?: string
          consent_ai_personalization?: boolean
          consent_marketing_email?: boolean
          consent_marketing_sms?: boolean
          created_at?: string
          extra?: Json
          favorite_colors?: string[] | null
          favorite_styles?: string[] | null
          last_updated_by?: string | null
          preferred_communication_channel?: string | null
          preferred_language?: string | null
          preferred_sms_time_window?: string | null
          salon_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_preferences_client_profile_id_fkey"
            columns: ["client_profile_id"]
            isOneToOne: true
            referencedRelation: "client_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_preferences_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      email_verification_tokens: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          salon_id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          salon_id: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          salon_id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_verification_tokens_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_cards: {
        Row: {
          client_phone: string
          client_profile_id: string | null
          created_at: string
          id: string
          last_stamp_at: string | null
          program_id: string
          rewards_earned: number
          rewards_redeemed: number
          salon_id: string
          stamps_current: number
          stamps_lifetime: number
          updated_at: string
        }
        Insert: {
          client_phone: string
          client_profile_id?: string | null
          created_at?: string
          id?: string
          last_stamp_at?: string | null
          program_id: string
          rewards_earned?: number
          rewards_redeemed?: number
          salon_id: string
          stamps_current?: number
          stamps_lifetime?: number
          updated_at?: string
        }
        Update: {
          client_phone?: string
          client_profile_id?: string | null
          created_at?: string
          id?: string
          last_stamp_at?: string | null
          program_id?: string
          rewards_earned?: number
          rewards_redeemed?: number
          salon_id?: string
          stamps_current?: number
          stamps_lifetime?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_cards_client_profile_id_fkey"
            columns: ["client_profile_id"]
            isOneToOne: false
            referencedRelation: "client_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_cards_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "loyalty_programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_cards_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_programs: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          min_spend_cents: number
          name: string
          reward_amount_off_cents: number | null
          reward_percent_off: number | null
          reward_service_id: string | null
          reward_type: string
          salon_id: string
          stamps_per_visit: number
          stamps_required: number
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          min_spend_cents?: number
          name?: string
          reward_amount_off_cents?: number | null
          reward_percent_off?: number | null
          reward_service_id?: string | null
          reward_type?: string
          salon_id: string
          stamps_per_visit?: number
          stamps_required?: number
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          min_spend_cents?: number
          name?: string
          reward_amount_off_cents?: number | null
          reward_percent_off?: number | null
          reward_service_id?: string | null
          reward_type?: string
          salon_id?: string
          stamps_per_visit?: number
          stamps_required?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_programs_reward_service_id_fkey"
            columns: ["reward_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_programs_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: true
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_stamp_events: {
        Row: {
          actor_user_id: string | null
          booking_id: string | null
          card_id: string
          created_at: string
          event_type: string
          id: string
          note: string | null
          salon_id: string
          stamps_after: number
          stamps_delta: number
        }
        Insert: {
          actor_user_id?: string | null
          booking_id?: string | null
          card_id: string
          created_at?: string
          event_type: string
          id?: string
          note?: string | null
          salon_id: string
          stamps_after: number
          stamps_delta: number
        }
        Update: {
          actor_user_id?: string | null
          booking_id?: string | null
          card_id?: string
          created_at?: string
          event_type?: string
          id?: string
          note?: string | null
          salon_id?: string
          stamps_after?: number
          stamps_delta?: number
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_stamp_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_stamp_events_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "loyalty_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_stamp_events_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
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
      party_link_claims: {
        Row: {
          booking_id: string
          claimed_at: string | null
          created_at: string
          id: string
          member_name: string | null
          member_phone: string | null
          party_link_id: string
          reminder_opted_in: boolean
        }
        Insert: {
          booking_id: string
          claimed_at?: string | null
          created_at?: string
          id?: string
          member_name?: string | null
          member_phone?: string | null
          party_link_id: string
          reminder_opted_in?: boolean
        }
        Update: {
          booking_id?: string
          claimed_at?: string | null
          created_at?: string
          id?: string
          member_name?: string | null
          member_phone?: string | null
          party_link_id?: string
          reminder_opted_in?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "party_link_claims_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_link_claims_party_link_id_fkey"
            columns: ["party_link_id"]
            isOneToOne: false
            referencedRelation: "party_links"
            referencedColumns: ["id"]
          },
        ]
      }
      party_links: {
        Row: {
          created_at: string
          expires_at: string
          group_id: string
          id: string
          mode: string
          salon_id: string
          token: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          group_id: string
          id?: string
          mode?: string
          salon_id: string
          token: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          group_id?: string
          id?: string
          mode?: string
          salon_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "party_links_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_otp_sessions: {
        Row: {
          consumed_at: string | null
          expires_at: string
          id: string
          phone: string
          salon_id: string
          verified_at: string
        }
        Insert: {
          consumed_at?: string | null
          expires_at?: string
          id?: string
          phone: string
          salon_id: string
          verified_at?: string
        }
        Update: {
          consumed_at?: string | null
          expires_at?: string
          id?: string
          phone?: string
          salon_id?: string
          verified_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_otp_sessions_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_announcements: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          published_at: string | null
          severity: string
          target: string
          title: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          published_at?: string | null
          severity?: string
          target?: string
          title: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          published_at?: string | null
          severity?: string
          target?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_feature_flags: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      platform_flags: {
        Row: {
          description: string | null
          enabled: boolean
          key: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          description?: string | null
          enabled?: boolean
          key: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          description?: string | null
          enabled?: boolean
          key?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          id: string
          resend_api_key: string | null
          resend_from: string | null
          twilio_account_sid: string | null
          twilio_auth_token: string | null
          twilio_phone_number: string | null
          twilio_verify_service_sid: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          resend_api_key?: string | null
          resend_from?: string | null
          twilio_account_sid?: string | null
          twilio_auth_token?: string | null
          twilio_phone_number?: string | null
          twilio_verify_service_sid?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          resend_api_key?: string | null
          resend_from?: string | null
          twilio_account_sid?: string | null
          twilio_auth_token?: string | null
          twilio_phone_number?: string | null
          twilio_verify_service_sid?: string | null
          updated_at?: string
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
      referrals: {
        Row: {
          code: string
          completed_at: string | null
          created_at: string
          expires_at: string
          id: string
          referee_booking_id: string | null
          referee_phone: string | null
          referee_profile_id: string | null
          referee_reward_percent_off: number | null
          referee_voucher_id: string | null
          referrer_phone: string
          referrer_profile_id: string | null
          referrer_reward_percent_off: number | null
          referrer_voucher_id: string | null
          salon_id: string
          share_url: string | null
          status: string
          updated_at: string
          used_at: string | null
        }
        Insert: {
          code: string
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          referee_booking_id?: string | null
          referee_phone?: string | null
          referee_profile_id?: string | null
          referee_reward_percent_off?: number | null
          referee_voucher_id?: string | null
          referrer_phone: string
          referrer_profile_id?: string | null
          referrer_reward_percent_off?: number | null
          referrer_voucher_id?: string | null
          salon_id: string
          share_url?: string | null
          status?: string
          updated_at?: string
          used_at?: string | null
        }
        Update: {
          code?: string
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          referee_booking_id?: string | null
          referee_phone?: string | null
          referee_profile_id?: string | null
          referee_reward_percent_off?: number | null
          referee_voucher_id?: string | null
          referrer_phone?: string
          referrer_profile_id?: string | null
          referrer_reward_percent_off?: number | null
          referrer_voucher_id?: string | null
          salon_id?: string
          share_url?: string | null
          status?: string
          updated_at?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "referrals_referee_booking_id_fkey"
            columns: ["referee_booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referee_profile_id_fkey"
            columns: ["referee_profile_id"]
            isOneToOne: false
            referencedRelation: "client_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referee_voucher_id_fkey"
            columns: ["referee_voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referrer_profile_id_fkey"
            columns: ["referrer_profile_id"]
            isOneToOne: false
            referencedRelation: "client_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referrer_voucher_id_fkey"
            columns: ["referrer_voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      register_completion_tokens: {
        Row: {
          created_at: string | null
          expires_at: string
          id: string
          payload: Json
          phone: string
          token: string
        }
        Insert: {
          created_at?: string | null
          expires_at: string
          id?: string
          payload?: Json
          phone: string
          token: string
        }
        Update: {
          created_at?: string | null
          expires_at?: string
          id?: string
          payload?: Json
          phone?: string
          token?: string
        }
        Relationships: []
      }
      reviews: {
        Row: {
          booking_id: string
          client_email: string | null
          client_phone: string | null
          created_at: string
          id: string
          message: string | null
          rating: number | null
          request_sent_at: string | null
          request_token: string
          salon_id: string
          service_id: string | null
          staff_id: string | null
          submitted_at: string | null
        }
        Insert: {
          booking_id: string
          client_email?: string | null
          client_phone?: string | null
          created_at?: string
          id?: string
          message?: string | null
          rating?: number | null
          request_sent_at?: string | null
          request_token: string
          salon_id: string
          service_id?: string | null
          staff_id?: string | null
          submitted_at?: string | null
        }
        Update: {
          booking_id?: string
          client_email?: string | null
          client_phone?: string | null
          created_at?: string
          id?: string
          message?: string | null
          rating?: number | null
          request_sent_at?: string | null
          request_token?: string
          salon_id?: string
          service_id?: string | null
          staff_id?: string | null
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reviews_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
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
      salon_page_sections: {
        Row: {
          content: Json
          created_at: string
          id: string
          is_visible: boolean
          salon_id: string
          sort_order: number
          title: string
          type: string
          updated_at: string
        }
        Insert: {
          content?: Json
          created_at?: string
          id?: string
          is_visible?: boolean
          salon_id: string
          sort_order?: number
          title?: string
          type: string
          updated_at?: string
        }
        Update: {
          content?: Json
          created_at?: string
          id?: string
          is_visible?: boolean
          salon_id?: string
          sort_order?: number
          title?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "salon_page_sections_salon_id_fkey"
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
          admin_notes: string | null
          archived_at: string | null
          booking_closed_dates: Json
          booking_verification_mode: string
          brand_color: string | null
          contact_email: string | null
          created_at: string | null
          currency_code: string | null
          dashboard_density: string
          dashboard_modules: Json
          dashboard_preset: string
          deposit_default_amount_cents: number | null
          deposit_high_value_cents: number
          description: string | null
          email: string | null
          email_verified: boolean | null
          feature_flags: Json
          google_review_url: string | null
          id: string
          is_beta: boolean
          name: string
          opening_hours: Json | null
          phone: string
          phone_otp_enabled: boolean
          plan_override: string | null
          profile_complete: boolean | null
          queue_display_mode: string
          reminder_24h_enabled: boolean
          reminder_3h_enabled: boolean
          reminders_enabled: boolean
          salon_phone: string | null
          setup_wizard_completed_at: string | null
          slug: string
          sms_reminders_enabled: boolean
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_current_period_end: string | null
          subscription_plan: string
          subscription_status: string
          superadmin_locked_at: string | null
          theme_mode: string | null
          timezone: string
          verification_risk_threshold_deposit: number
          verification_risk_threshold_otp: number
          voice_ai_enabled: boolean
          voice_ai_persona_name: string
          voice_ai_persona_voice: string
          voice_ai_reasoning_effort: string
          voice_ai_sessions_limit: number
          voice_ai_sessions_reset_at: string
          voice_ai_sessions_this_month: number
          walkin_auto_assign: boolean
        }
        Insert: {
          address?: string | null
          admin_notes?: string | null
          archived_at?: string | null
          booking_closed_dates?: Json
          booking_verification_mode?: string
          brand_color?: string | null
          contact_email?: string | null
          created_at?: string | null
          currency_code?: string | null
          dashboard_density?: string
          dashboard_modules?: Json
          dashboard_preset?: string
          deposit_default_amount_cents?: number | null
          deposit_high_value_cents?: number
          description?: string | null
          email?: string | null
          email_verified?: boolean | null
          feature_flags?: Json
          google_review_url?: string | null
          id?: string
          is_beta?: boolean
          name: string
          opening_hours?: Json | null
          phone: string
          phone_otp_enabled?: boolean
          plan_override?: string | null
          profile_complete?: boolean | null
          queue_display_mode?: string
          reminder_24h_enabled?: boolean
          reminder_3h_enabled?: boolean
          reminders_enabled?: boolean
          salon_phone?: string | null
          setup_wizard_completed_at?: string | null
          slug: string
          sms_reminders_enabled?: boolean
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_current_period_end?: string | null
          subscription_plan?: string
          subscription_status?: string
          superadmin_locked_at?: string | null
          theme_mode?: string | null
          timezone?: string
          verification_risk_threshold_deposit?: number
          verification_risk_threshold_otp?: number
          voice_ai_enabled?: boolean
          voice_ai_persona_name?: string
          voice_ai_persona_voice?: string
          voice_ai_reasoning_effort?: string
          voice_ai_sessions_limit?: number
          voice_ai_sessions_reset_at?: string
          voice_ai_sessions_this_month?: number
          walkin_auto_assign?: boolean
        }
        Update: {
          address?: string | null
          admin_notes?: string | null
          archived_at?: string | null
          booking_closed_dates?: Json
          booking_verification_mode?: string
          brand_color?: string | null
          contact_email?: string | null
          created_at?: string | null
          currency_code?: string | null
          dashboard_density?: string
          dashboard_modules?: Json
          dashboard_preset?: string
          deposit_default_amount_cents?: number | null
          deposit_high_value_cents?: number
          description?: string | null
          email?: string | null
          email_verified?: boolean | null
          feature_flags?: Json
          google_review_url?: string | null
          id?: string
          is_beta?: boolean
          name?: string
          opening_hours?: Json | null
          phone?: string
          phone_otp_enabled?: boolean
          plan_override?: string | null
          profile_complete?: boolean | null
          queue_display_mode?: string
          reminder_24h_enabled?: boolean
          reminder_3h_enabled?: boolean
          reminders_enabled?: boolean
          salon_phone?: string | null
          setup_wizard_completed_at?: string | null
          slug?: string
          sms_reminders_enabled?: boolean
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_current_period_end?: string | null
          subscription_plan?: string
          subscription_status?: string
          superadmin_locked_at?: string | null
          theme_mode?: string | null
          timezone?: string
          verification_risk_threshold_deposit?: number
          verification_risk_threshold_otp?: number
          voice_ai_enabled?: boolean
          voice_ai_persona_name?: string
          voice_ai_persona_voice?: string
          voice_ai_reasoning_effort?: string
          voice_ai_sessions_limit?: number
          voice_ai_sessions_reset_at?: string
          voice_ai_sessions_this_month?: number
          walkin_auto_assign?: boolean
        }
        Relationships: []
      }
      service_categories: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          id: string
          name_en: string
          name_vi: string
          slug: string
          sort_order: number | null
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          name_en: string
          name_vi: string
          slug: string
          sort_order?: number | null
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          name_en?: string
          name_vi?: string
          slug?: string
          sort_order?: number | null
        }
        Relationships: []
      }
      service_combos: {
        Row: {
          created_at: string
          description: string | null
          discount_cents: number
          duration_minutes: number
          id: string
          is_active: boolean
          name: string
          position: number
          price_cents: number
          salon_id: string
          service_ids: string[]
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          discount_cents?: number
          duration_minutes?: number
          id?: string
          is_active?: boolean
          name: string
          position?: number
          price_cents?: number
          salon_id: string
          service_ids?: string[]
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          discount_cents?: number
          duration_minutes?: number
          id?: string
          is_active?: boolean
          name?: string
          position?: number
          price_cents?: number
          salon_id?: string
          service_ids?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_combos_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          buffer_minutes: number
          category: string | null
          created_at: string | null
          deleted_at: string | null
          description: string | null
          duration_minutes: number
          id: string
          is_featured: boolean
          is_popular: boolean
          name: string
          price_cents: number
          salon_id: string
        }
        Insert: {
          buffer_minutes?: number
          category?: string | null
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          duration_minutes: number
          id?: string
          is_featured?: boolean
          is_popular?: boolean
          name: string
          price_cents: number
          salon_id: string
        }
        Update: {
          buffer_minutes?: number
          category?: string | null
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          duration_minutes?: number
          id?: string
          is_featured?: boolean
          is_popular?: boolean
          name?: string
          price_cents?: number
          salon_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_category_fk"
            columns: ["category"]
            isOneToOne: false
            referencedRelation: "service_categories"
            referencedColumns: ["slug"]
          },
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
          deleted_at: string | null
          id: string
          job_role: string
          name: string
          salon_id: string
          status: string
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          job_role?: string
          name: string
          salon_id: string
          status?: string
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
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
      superadmin_audit_logs: {
        Row: {
          action: string
          actor_role: string
          actor_user_id: string | null
          after_jsonb: Json | null
          before_jsonb: Json | null
          created_at: string
          id: string
          reason: string | null
          target_id: string | null
          target_kind: string | null
        }
        Insert: {
          action: string
          actor_role: string
          actor_user_id?: string | null
          after_jsonb?: Json | null
          before_jsonb?: Json | null
          created_at?: string
          id?: string
          reason?: string | null
          target_id?: string | null
          target_kind?: string | null
        }
        Update: {
          action?: string
          actor_role?: string
          actor_user_id?: string | null
          after_jsonb?: Json | null
          before_jsonb?: Json | null
          created_at?: string
          id?: string
          reason?: string | null
          target_id?: string | null
          target_kind?: string | null
        }
        Relationships: []
      }
      superadmins: {
        Row: {
          created_at: string
          created_by: string | null
          revoked_at: string | null
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          revoked_at?: string | null
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          revoked_at?: string | null
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      voice_ai_sessions: {
        Row: {
          booking_id: string | null
          client_name: string | null
          client_phone: string | null
          created_at: string
          duration_seconds: number
          ended_at: string | null
          error_message: string | null
          estimated_cost_usd: number | null
          id: string
          language: string
          openai_session_id: string | null
          salon_id: string
          service_changed: boolean | null
          started_at: string
          status: string
          time_changed: boolean | null
          transcript: Json
          upsell_accepted: boolean | null
        }
        Insert: {
          booking_id?: string | null
          client_name?: string | null
          client_phone?: string | null
          created_at?: string
          duration_seconds?: number
          ended_at?: string | null
          error_message?: string | null
          estimated_cost_usd?: number | null
          id?: string
          language?: string
          openai_session_id?: string | null
          salon_id: string
          service_changed?: boolean | null
          started_at?: string
          status?: string
          time_changed?: boolean | null
          transcript?: Json
          upsell_accepted?: boolean | null
        }
        Update: {
          booking_id?: string | null
          client_name?: string | null
          client_phone?: string | null
          created_at?: string
          duration_seconds?: number
          ended_at?: string | null
          error_message?: string | null
          estimated_cost_usd?: number | null
          id?: string
          language?: string
          openai_session_id?: string | null
          salon_id?: string
          service_changed?: boolean | null
          started_at?: string
          status?: string
          time_changed?: boolean | null
          transcript?: Json
          upsell_accepted?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "voice_ai_sessions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_ai_sessions_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      voucher_redemptions: {
        Row: {
          booking_id: string | null
          client_phone: string
          discount_applied_cents: number
          final_price_cents: number | null
          id: string
          original_price_cents: number | null
          redeemed_at: string
          redeemed_by_user_id: string | null
          salon_id: string
          voucher_id: string
        }
        Insert: {
          booking_id?: string | null
          client_phone: string
          discount_applied_cents: number
          final_price_cents?: number | null
          id?: string
          original_price_cents?: number | null
          redeemed_at?: string
          redeemed_by_user_id?: string | null
          salon_id: string
          voucher_id: string
        }
        Update: {
          booking_id?: string | null
          client_phone?: string
          discount_applied_cents?: number
          final_price_cents?: number | null
          id?: string
          original_price_cents?: number | null
          redeemed_at?: string
          redeemed_by_user_id?: string | null
          salon_id?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voucher_redemptions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voucher_redemptions_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voucher_redemptions_voucher_id_fkey"
            columns: ["voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
        ]
      }
      vouchers: {
        Row: {
          amount_off_cents: number | null
          applicable_service_category: string | null
          applicable_service_ids: string[] | null
          client_phone: string | null
          client_profile_id: string | null
          code: string
          created_at: string
          created_by_user_id: string | null
          expires_at: string
          free_service_id: string | null
          gift_card_from_name: string | null
          gift_card_message: string | null
          gift_card_purchaser_phone: string | null
          gift_card_stripe_payment_intent_id: string | null
          gift_card_value_cents: number | null
          id: string
          kind: string
          max_uses: number
          min_spend_cents: number | null
          percent_off: number | null
          revoked_at: string | null
          revoked_reason: string | null
          salon_id: string
          updated_at: string
          used_count: number
          valid_from: string
        }
        Insert: {
          amount_off_cents?: number | null
          applicable_service_category?: string | null
          applicable_service_ids?: string[] | null
          client_phone?: string | null
          client_profile_id?: string | null
          code: string
          created_at?: string
          created_by_user_id?: string | null
          expires_at: string
          free_service_id?: string | null
          gift_card_from_name?: string | null
          gift_card_message?: string | null
          gift_card_purchaser_phone?: string | null
          gift_card_stripe_payment_intent_id?: string | null
          gift_card_value_cents?: number | null
          id?: string
          kind: string
          max_uses?: number
          min_spend_cents?: number | null
          percent_off?: number | null
          revoked_at?: string | null
          revoked_reason?: string | null
          salon_id: string
          updated_at?: string
          used_count?: number
          valid_from?: string
        }
        Update: {
          amount_off_cents?: number | null
          applicable_service_category?: string | null
          applicable_service_ids?: string[] | null
          client_phone?: string | null
          client_profile_id?: string | null
          code?: string
          created_at?: string
          created_by_user_id?: string | null
          expires_at?: string
          free_service_id?: string | null
          gift_card_from_name?: string | null
          gift_card_message?: string | null
          gift_card_purchaser_phone?: string | null
          gift_card_stripe_payment_intent_id?: string | null
          gift_card_value_cents?: number | null
          id?: string
          kind?: string
          max_uses?: number
          min_spend_cents?: number | null
          percent_off?: number | null
          revoked_at?: string | null
          revoked_reason?: string | null
          salon_id?: string
          updated_at?: string
          used_count?: number
          valid_from?: string
        }
        Relationships: [
          {
            foreignKeyName: "vouchers_client_profile_id_fkey"
            columns: ["client_profile_id"]
            isOneToOne: false
            referencedRelation: "client_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vouchers_free_service_id_fkey"
            columns: ["free_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vouchers_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
        ]
      }
      website_import_jobs: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          progress: number
          result: Json | null
          salon_id: string
          source_url: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          progress?: number
          result?: Json | null
          salon_id: string
          source_url: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          progress?: number
          result?: Json | null
          salon_id?: string
          source_url?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "website_import_jobs_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
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
      cancel_booking_as_customer: {
        Args: { p_token_id: string }
        Returns: {
          booking_id: string
          code: string
          ok: boolean
        }[]
      }
      check_group_slots_available: { Args: { p_slots: Json }; Returns: Json }
      claim_party_slot: {
        Args: {
          p_claim_id: string
          p_member_name: string
          p_member_phone: string
          p_reminder_opted_in: boolean
          p_token: string
        }
        Returns: Json
      }
      claim_waitlist_slot: {
        Args: { p_claim_token: string }
        Returns: {
          client_email: string
          client_name: string
          client_phone: string
          id: string
        }[]
      }
      compute_no_show_risk: {
        Args: {
          p_no_show_count: number
          p_subtotal_cents: number
          p_visit_count: number
        }
        Returns: number
      }
      confirm_booking_as_customer: {
        Args: { p_token_id: string }
        Returns: {
          booking_id: string
          code: string
          ok: boolean
          service_name: string
          staff_name: string
          start_utc: string
        }[]
      }
      confirm_booking_with_otp: {
        Args: { p_booking_id: string; p_otp_session_id: string }
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
          p_client_email?: string
          p_client_name: string
          p_client_phone: string
          p_preferred_slot_label: string
          p_salon_id: string
          p_service_id: string
          p_source: string
          p_staff_id: string
        }
        Returns: {
          id: string
        }[]
      }
      create_referral_code: {
        Args: {
          p_referee_reward?: number
          p_referrer_phone: string
          p_referrer_reward?: number
          p_salon_id: string
        }
        Returns: Json
      }
      determine_booking_verification: {
        Args: {
          p_client_phone: string
          p_salon_id: string
          p_service_ids: string[]
          p_subtotal_cents: number
        }
        Returns: Json
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
      increment_voice_session_if_under_limit: {
        Args: { p_salon_id: string }
        Returns: boolean
      }
      insert_group_bookings: { Args: { p_bookings: Json }; Returns: Json }
      public_booking_occupancy_for_range: {
        Args: { p_end: string; p_salon_id: string; p_start: string }
        Returns: {
          end_time_utc: string
          staff_id: string
          start_time_utc: string
        }[]
      }
      reschedule_booking_as_customer: {
        Args: {
          p_new_end_utc: string
          p_new_start_utc: string
          p_token_id: string
        }
        Returns: {
          booking_id: string
          code: string
          new_start_utc: string
          ok: boolean
          service_name: string
          staff_name: string
        }[]
      }
      salon_has_staff_services: {
        Args: { p_salon_id: string }
        Returns: boolean
      }
      seed_default_page_sections: {
        Args: { p_salon_id: string }
        Returns: undefined
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
