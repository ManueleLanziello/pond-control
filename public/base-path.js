export function pondControlBasePath(pathname = globalThis.location?.pathname ?? '/') {
  return pathname === '/pond' || pathname.startsWith('/pond/') ? '/pond' : '';
}

export function pondControlPath(pathname, locationPathname) {
  return `${pondControlBasePath(locationPathname)}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
