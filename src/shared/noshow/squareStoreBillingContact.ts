export type SquareStoreBillingContact = Record<string, string>;

/**
 * Builds the buyer contact Square uses while tokenizing a card for STORE.
 * Only booking fields the customer already supplied are included. Card data
 * remains inside Square's hosted fields and never passes through this helper.
 */
export function buildSquareStoreBillingContact({
  name,
  phone,
  email,
}: {
  name: string;
  phone: string;
  email: string;
}): SquareStoreBillingContact {
  const contact: SquareStoreBillingContact = {};
  const nameParts = name.trim().split(/\s+/).filter(Boolean);
  const phoneValue = phone.trim();
  const emailValue = email.trim();

  if (nameParts.length > 0) {
    contact.givenName = nameParts[0];
    if (nameParts.length > 1) contact.familyName = nameParts.slice(1).join(" ");
  }
  if (phoneValue) contact.phone = phoneValue;
  if (emailValue) contact.email = emailValue;

  return contact;
}
