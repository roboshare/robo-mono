const DEFAULT_APP_HOST = "app.roboshare.finance";

const configuredAppHost = process.env.NEXT_PUBLIC_ROBOSHARE_APP_HOST?.trim().toLowerCase();
const isProductionDeployment = process.env.VERCEL_ENV === "production";

export const getConfiguredAppHost = () => configuredAppHost || DEFAULT_APP_HOST;

export const toConfiguredAppHref = (href: string) => {
  if (!href.startsWith("/")) {
    return href;
  }

  if (!configuredAppHost && !isProductionDeployment) {
    return href;
  }

  return `https://${getConfiguredAppHost()}${href}`;
};
