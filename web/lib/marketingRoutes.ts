export const isMarketingContentPath = (pathname: string | null) =>
  pathname === "/" ||
  pathname === "/robomata" ||
  pathname?.startsWith("/products/") ||
  pathname === "/partners" ||
  pathname?.startsWith("/partners/");
