-- Legacy rows stored US/CA NANP numbers as 10 digits; lookups use 11 digits (leading 1) after OTP.
UPDATE public.salons
SET phone = '1' || phone
WHERE phone ~ '^[2-9][0-9]{9}$';
