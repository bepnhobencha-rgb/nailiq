-- Migration: referral helper RPCs
-- Adds create_referral_code() function for generating unique referral codes.

CREATE OR REPLACE FUNCTION public.create_referral_code(
  p_salon_id uuid,
  p_referrer_phone text,
  p_referrer_reward int DEFAULT 10,
  p_referee_reward int DEFAULT 10
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_code text;
  v_id uuid;
  v_attempts int := 0;
BEGIN
  -- Generate a unique 6-char uppercase alphanumeric code
  LOOP
    v_code := upper(substring(md5(random()::text) from 1 for 6));
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.referrals
      WHERE salon_id = p_salon_id AND code = v_code
    );
    v_attempts := v_attempts + 1;
    IF v_attempts > 10 THEN
      RAISE EXCEPTION 'code_collision';
    END IF;
  END LOOP;

  INSERT INTO public.referrals (
    salon_id,
    referrer_phone,
    code,
    referrer_reward_percent_off,
    referee_reward_percent_off,
    status,
    expires_at
  )
  VALUES (
    p_salon_id,
    p_referrer_phone,
    v_code,
    p_referrer_reward,
    p_referee_reward,
    'pending',
    now() + interval '1 year'
  )
  RETURNING id INTO v_id;

  RETURN json_build_object('id', v_id, 'code', v_code);
END;
$$;

-- Grant execute to service role (edge functions use service role key)
GRANT EXECUTE ON FUNCTION public.create_referral_code(uuid, text, int, int) TO service_role;
