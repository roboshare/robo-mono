import "server-only";
import type {
  RenterVerificationActor,
  RenterVerificationKind,
  RenterVerificationUpdate,
} from "~~/lib/robomata/rentalRenters";

const PROVIDER_ENV_BY_KIND: Record<RenterVerificationKind, string> = {
  driver_license: "ROBOMATA_RENTER_DRIVER_LICENSE_PROVIDER",
  identity: "ROBOMATA_RENTER_IDENTITY_PROVIDER",
  sanctions: "ROBOMATA_RENTER_SANCTIONS_PROVIDER",
};

function normalizedProvider(provider: string | undefined): string {
  return provider?.trim().toLowerCase() ?? "";
}

function isForcedProviderConfigEnabled() {
  return process.env.ROBOMATA_RENTER_VERIFICATION_REQUIRE_PROVIDER_CONFIG === "true";
}

export function isRenterVerificationProviderConfigRequired() {
  return process.env.NODE_ENV !== "development" || isForcedProviderConfigEnabled();
}

export function configuredRenterVerificationProviders(): Record<RenterVerificationKind, string | undefined> {
  return {
    driver_license: process.env.ROBOMATA_RENTER_DRIVER_LICENSE_PROVIDER?.trim() || undefined,
    identity: process.env.ROBOMATA_RENTER_IDENTITY_PROVIDER?.trim() || undefined,
    sanctions: process.env.ROBOMATA_RENTER_SANCTIONS_PROVIDER?.trim() || undefined,
  };
}

export function renterVerificationProviderPolicy() {
  const providers = configuredRenterVerificationProviders();
  return {
    providerEnvByKind: PROVIDER_ENV_BY_KIND,
    providers,
    requireProviderConfig: isRenterVerificationProviderConfigRequired(),
  };
}

export function normalizeRenterVerificationProviderUpdate(input: RenterVerificationUpdate): RenterVerificationUpdate {
  const providers = configuredRenterVerificationProviders();
  const configuredProvider = input.kind ? providers[input.kind] : undefined;
  const callbackProvider = input.provider?.trim();
  const providerConfigRequired = isRenterVerificationProviderConfigRequired();

  if (input.decisionSource && input.decisionSource !== "provider") {
    throw new Error("Provider verification callbacks must use decisionSource=provider.");
  }
  if (!input.kind) throw new Error("Provider verification callbacks require a check kind.");
  if (providerConfigRequired && !configuredProvider) {
    throw new Error(
      `Renter verification provider for ${input.kind} is not configured. Set ${PROVIDER_ENV_BY_KIND[input.kind]}.`,
    );
  }
  if (!callbackProvider) {
    throw new Error("Provider verification callbacks require provider attribution.");
  }
  if (configuredProvider && normalizedProvider(callbackProvider) !== normalizedProvider(configuredProvider)) {
    throw new Error(`Provider ${callbackProvider} is not configured for ${input.kind} renter verification.`);
  }
  if (!input.providerReferenceId?.trim()) {
    throw new Error("Provider verification callbacks require providerReferenceId.");
  }

  const provider = configuredProvider ?? callbackProvider;
  const actor: RenterVerificationActor = input.actor ?? {
    displayName: provider,
    id: provider,
    type: "provider",
  };
  if (actor.type !== "provider") {
    throw new Error("Provider verification callbacks require provider actor attribution.");
  }

  return {
    ...input,
    actor,
    decisionSource: "provider",
    provider,
    providerReferenceId: input.providerReferenceId.trim(),
  };
}
