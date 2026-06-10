import { NextRequest, NextResponse } from "next/server";

const DEFAULT_MARKETING_HOSTS = ["roboshare.finance", "www.roboshare.finance"];
const DEFAULT_PRIMARY_MARKETING_HOST = "www.roboshare.finance";
const DEFAULT_APP_HOST = "app.roboshare.finance";

const parseHosts = (value: string | undefined, fallback: string[]) => {
  const hosts = value
    ?.split(",")
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);

  return hosts && hosts.length > 0 ? hosts : fallback;
};

const marketingHosts = parseHosts(process.env.ROBOSHARE_MARKETING_HOSTS, DEFAULT_MARKETING_HOSTS);
const primaryMarketingHost = process.env.ROBOSHARE_PRIMARY_MARKETING_HOST ?? DEFAULT_PRIMARY_MARKETING_HOST;
const appHost = process.env.ROBOSHARE_APP_HOST ?? DEFAULT_APP_HOST;

const isAppOnlyPath = (pathname: string) =>
  pathname === "/operator" ||
  pathname.startsWith("/operator/") ||
  pathname === "/partner" ||
  pathname.startsWith("/partner/") ||
  pathname === "/subgraph" ||
  pathname.startsWith("/subgraph/") ||
  pathname === "/debug" ||
  pathname.startsWith("/debug/") ||
  pathname === "/blockexplorer" ||
  pathname.startsWith("/blockexplorer/") ||
  pathname.startsWith("/lender/packet/");

const isMarketingOnlyPath = (pathname: string) =>
  pathname === "/" ||
  pathname === "/robomata" ||
  pathname.startsWith("/products/") ||
  pathname === "/partners" ||
  pathname.startsWith("/partners/");

const redirectToHost = (request: NextRequest, host: string) => {
  const url = request.nextUrl.clone();
  url.protocol = "https:";
  url.host = host;
  return NextResponse.redirect(url);
};

export function middleware(request: NextRequest) {
  const host = (request.headers.get("host")?.split(":")[0] ?? request.nextUrl.hostname).toLowerCase();
  const { pathname } = request.nextUrl;
  const isMarketingHost = marketingHosts.includes(host);
  const isAppHost = host === appHost.toLowerCase();

  if (isMarketingHost && isAppOnlyPath(pathname)) {
    return redirectToHost(request, appHost);
  }

  if (isAppHost && isMarketingOnlyPath(pathname)) {
    return redirectToHost(request, primaryMarketingHost);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|opengraph-image.png|twitter-image.png).*)"],
};
