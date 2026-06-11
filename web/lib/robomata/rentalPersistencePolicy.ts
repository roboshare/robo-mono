export const ROBOMATA_RENTAL_PERSISTENCE_SCHEMA_VERSION = "rental-persistence-v1";

export const RENTAL_PERSISTENCE_RETENTION_BOUNDARIES = {
  auditEvents: "Retain operational audit events for the legal/compliance retention window; avoid raw PII payloads.",
  bookingRecords: "Retain booking records for accounting, support, and dispute windows.",
  claimEvidence:
    "Retain evidence references, digests, and notes only; raw images, documents, and provider payloads stay outside Roboshare.",
  paymentProviderData:
    "Retain provider IDs, status, amounts, and timestamps only; raw payment method data and client secrets stay with Stripe.",
  renterVerification:
    "Retain verification status, provider references, expiry, actor attribution, and audit events only.",
};

const PROHIBITED_PERSISTENCE_KEYS = new Set([
  "accountnumber",
  "bankaccount",
  "bankaccountnumber",
  "biometric",
  "biometricartifact",
  "birthdate",
  "card",
  "cardnumber",
  "clientsecret",
  "cvv",
  "cvc",
  "dateofbirth",
  "dob",
  "documentimage",
  "documentscan",
  "driverlicensenumber",
  "fullssn",
  "identitydocument",
  "identitydocumentimage",
  "licenseimage",
  "licenseplate",
  "licensenumber",
  "licensephoto",
  "paymentmethoddata",
  "rawdocument",
  "rawpaymentmethod",
  "rawproviderpayload",
  "rawproviderresponse",
  "rawsanctionspayload",
  "routingnumber",
  "sanctionspayload",
  "selfie",
  "socialsecuritynumber",
  "ssn",
  "stripeclientsecret",
  "vin",
]);

function normalizedPersistenceKey(key: string): string {
  return key.replace(/[\s_-]/g, "").toLowerCase();
}

export function assertNoProhibitedRentalPersistenceFields(value: unknown, context: string): void {
  const visited = new WeakSet<object>();

  function visit(candidate: unknown, path: string) {
    if (!candidate || typeof candidate !== "object") return;
    if (visited.has(candidate)) return;
    visited.add(candidate);

    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    for (const [key, child] of Object.entries(candidate)) {
      const normalizedKey = normalizedPersistenceKey(key);
      if (PROHIBITED_PERSISTENCE_KEYS.has(normalizedKey)) {
        throw new Error(
          `${context} includes prohibited rental persistence field "${path}.${key}". Store provider references and digests instead of raw PII, payment, or provider payload data.`,
        );
      }
      visit(child, `${path}.${key}`);
    }
  }

  visit(value, context);
}
