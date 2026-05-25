export type LoyaltyProgram = {
  id: string;
  salon_id: string;
  name: string;
  is_active: boolean;
  stamps_required: number;
  reward_type: "free_service" | "percent_off" | "amount_off";
  reward_service_id: string | null;
  reward_percent_off: number | null;
  reward_amount_off_cents: number | null;
  stamps_per_visit: number;
  min_spend_cents: number;
  description: string | null;
  color: string;
  created_at: string;
  updated_at: string;
};

export type LoyaltyCard = {
  id: string;
  salon_id: string;
  program_id: string;
  client_phone: string;
  client_profile_id: string | null;
  stamps_current: number;
  stamps_lifetime: number;
  rewards_earned: number;
  rewards_redeemed: number;
  last_stamp_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LoyaltyStampEvent = {
  id: string;
  salon_id: string;
  card_id: string;
  booking_id: string | null;
  event_type: "earn" | "redeem" | "manual_add" | "manual_remove" | "expire";
  stamps_delta: number;
  stamps_after: number;
  note: string | null;
  actor_user_id: string | null;
  created_at: string;
};

export type LoyaltyStats = {
  totalCards: number;
  activeCards: number;
  stampsIssuedToday: number;
  rewardsRedeemedThisMonth: number;
};

export type GiftCard = {
  id: string;
  salon_id: string;
  code: string;
  kind: "gift";
  amount_off_cents: number | null;
  gift_card_value_cents: number | null;
  gift_card_from_name: string | null;
  gift_card_message: string | null;
  gift_card_purchaser_phone: string | null;
  expires_at: string;
  used_count: number;
  max_uses: number;
  revoked_at: string | null;
};
