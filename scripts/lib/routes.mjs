// The function routes of vercel.json, as scripts/serve.mjs mirrors them: every file under
// "functions" answers its own path (api/health.js -> /api/health), and every rewrite whose
// destination is such a path adds a pattern for that file. A rewritten function still sees the
// original URL, as on Vercel, so a pattern's parameters are read from request.url.
//
// Patterns use the subset of Vercel's syntax that vercel.json needs: literal segments, ":name" for
// one segment, ":name*" for zero or more trailing segments and ":name+" for one or more.

/**
 * @typedef {{ pattern: string, file: string, re: RegExp, names: string[] }} Route
 * @typedef {{ functions?: Record<string, unknown>, rewrites?: Array<{ source: string, destination: string }> }} VercelConfig
 */

/**
 * The URL path a function file answers: "api/models/pool.js" -> "/api/models/pool".
 * @param {string} file
 */
export function functionPath(file) {
  if (!/^api\/(?:[\w-]+\/)*[\w-]+\.js$/.test(file)) throw new Error(`vercel.json: unexpected function file ${file}`);
  return `/${file.replace(/\.js$/, '')}`;
}

/**
 * @param {string} pattern e.g. "/api/relay/:provider/:path*"
 * @returns {{ re: RegExp, names: string[] }}
 */
export function compilePattern(pattern) {
  if (!pattern.startsWith('/')) throw new Error(`route pattern ${pattern} must start with "/"`);
  /** @type {string[]} */
  const names = [];
  const segments = pattern.slice(1).split('/');
  let source = '';
  for (const [i, segment] of segments.entries()) {
    const param = /^:(\w+)([*+]?)$/.exec(segment);
    if (!param) {
      if (segment.includes(':') || segment.includes('(')) throw new Error(`route pattern ${pattern}: unsupported segment ${segment}`);
      source += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
      continue;
    }
    names.push(param[1]);
    if (param[2] === '') {
      source += '/([^/]+)';
      continue;
    }
    if (i !== segments.length - 1) throw new Error(`route pattern ${pattern}: ${segment} must be the last segment`);
    source += param[2] === '*' ? '(?:/(.*))?' : '/(.+)';
  }
  return { re: new RegExp(`^${source}$`), names };
}

/**
 * The route table of a vercel.json: exact function paths first, then the rewrites in file order.
 * @param {VercelConfig} vercel
 * @returns {Route[]}
 */
export function functionRoutes(vercel) {
  const files = Object.keys(vercel.functions ?? {});
  /** @type {Map<string, string>} path -> file */
  const byPath = new Map(files.map((file) => [functionPath(file), file]));
  /** @type {Route[]} */
  const routes = [...byPath].map(([pattern, file]) => ({ pattern, file, ...compilePattern(pattern) }));
  for (const rewrite of vercel.rewrites ?? []) {
    const file = byPath.get(rewrite.destination);
    if (!file) throw new Error(`vercel.json: the rewrite of ${rewrite.source} points at ${rewrite.destination}, which is no function`);
    routes.push({ pattern: rewrite.source, file, ...compilePattern(rewrite.source) });
  }
  return routes;
}

/**
 * The route that answers a path, with its parameters (a trailing ":name*" without segments is "").
 * @param {Route[]} routes
 * @param {string} pathname
 * @returns {{ route: Route, params: Record<string, string> } | null}
 */
export function matchRoute(routes, pathname) {
  for (const route of routes) {
    const m = route.re.exec(pathname);
    if (m) return { route, params: Object.fromEntries(route.names.map((name, i) => [name, m[i + 1] ?? ''])) };
  }
  return null;
}
