import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';

const dataURL = new URL('../.runtime/incidents.json', import.meta.url);
const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
const facets = {
  service: ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations'],
  status: ['open', 'in_progress', 'resolved'],
  severity: ['critical', 'high', 'medium', 'low'],
};
const fields = ['id', 'title', 'description', 'service', 'severity', 'status', 'openedAt', 'resolvedAt', 'team', 'region', 'tags'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

class RequestError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = 'INVALID_QUERY'; }
}

function parseQuery(params, exporting) {
  const allowed = new Set(['q', ...Object.keys(facets), 'from', 'to', 'sort', 'direction', 'page', 'pageSize']);
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new RequestError(`Unknown parameter: ${key}`);
  }
  const scalar = (key, fallback) => {
    if (params.getAll(key).length > 1) throw new RequestError(`${key} must appear only once`);
    return params.get(key) ?? fallback;
  };
  const query = { q: scalar('q', '').toLowerCase() };
  for (const [key, values] of Object.entries(facets)) {
    query[key] = params.getAll(key);
    if (query[key].some(value => !values.includes(value))) {
      throw new RequestError(`${key} must be one of: ${values.join(', ')}`);
    }
  }
  for (const key of ['from', 'to']) {
    const value = scalar(key, undefined);
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value)) {
      throw new RequestError(`${key} must be a valid UTC YYYY-MM-DD date`);
    }
    query[key] = value;
  }
  if (query.from && query.to && query.from > query.to) throw new RequestError('from must be on or before to');
  query.sort = scalar('sort', 'openedAt');
  query.direction = scalar('direction', 'desc');
  if (!['openedAt', 'severity'].includes(query.sort)) throw new RequestError('sort must be openedAt or severity');
  if (!['asc', 'desc'].includes(query.direction)) throw new RequestError('direction must be asc or desc');
  if (!exporting) {
    const page = scalar('page', '1');
    if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page))) throw new RequestError('page must be a positive safe integer');
    query.page = Number(page);
    const size = scalar('pageSize', '25');
    if (!['25', '50'].includes(size)) throw new RequestError('pageSize must be 25 or 50');
    query.pageSize = Number(size);
  }
  return query;
}

function matching(rows, query) {
  const result = rows.filter(row =>
    ['id', 'title', 'description'].some(key => row[key].toLowerCase().includes(query.q)) &&
    Object.keys(facets).every(key => !query[key].length || query[key].includes(row[key])) &&
    (!query.from || row.openedAt.slice(0, 10) >= query.from) &&
    (!query.to || row.openedAt.slice(0, 10) <= query.to));
  const sign = query.direction === 'asc' ? 1 : -1;
  result.sort((a, b) => {
    if (query.sort === 'severity') {
      // Larger numeric priority means higher severity.
      const priority = row => 4 - facets.severity.indexOf(row.severity);
      return sign * compare(priority(a), priority(b)) || compare(b.openedAt, a.openedAt) || compare(a.id, b.id);
    }
    return sign * compare(a.openedAt, b.openedAt) || compare(a.id, b.id);
  });
  return result;
}

function summary(rows) {
  const days = new Map();
  for (const row of rows) {
    const day = row.openedAt.slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return {
    total: rows.length,
    unresolved: rows.filter(row => row.status !== 'resolved').length,
    highSeverity: rows.filter(row => ['critical', 'high'].includes(row.severity)).length,
    openedByDay: [...days].sort(([a], [b]) => compare(a, b)).map(([date, count]) => ({ date, count })),
  };
}

function csvCell(value) {
  const text = value === null ? '' : Array.isArray(value) ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function overview(rows) {
  const services = new Map();
  for (const row of rows) {
    if (!services.has(row.service)) {
      services.set(row.service, { service: row.service, incidentCount: 0, unresolvedCount: 0, highSeverityCount: 0, resolvedCount: 0, resolutionMilliseconds: 0 });
    }
    const measures = services.get(row.service);
    measures.incidentCount++;
    if (row.status === 'resolved') {
      measures.resolvedCount++;
      measures.resolutionMilliseconds += Date.parse(row.resolvedAt) - Date.parse(row.openedAt);
    } else measures.unresolvedCount++;
    if (['critical', 'high'].includes(row.severity)) measures.highSeverityCount++;
  }
  return {
    services: [...services.values()]
      .sort((a, b) => b.unresolvedCount - a.unresolvedCount || compare(a.service, b.service))
      .map(({ resolvedCount, resolutionMilliseconds, ...measures }) => ({
        ...measures,
        averageResolutionHours: resolvedCount ? resolutionMilliseconds / resolvedCount / 3600000 : null,
      })),
  };
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function servePublic(pathname, response) {
  let root, path;
  try {
    root = await realpath(publicPath);
    path = await realpath(resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`));
  } catch { return json(response, 404, { error: { code: 'NOT_FOUND', message: 'File not found' } }); }
  if (!path.startsWith(root + sep)) return json(response, 404, { error: { code: 'NOT_FOUND', message: 'File not found' } });
  let bytes;
  try { bytes = await readFile(path); }
  catch { return json(response, 404, { error: { code: 'NOT_FOUND', message: 'File not found' } }); }
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  response.end(bytes);
}

export async function createAppServer() {
  const rows = JSON.parse(await readFile(dataURL, 'utf8'));
  const byId = new Map(rows.map(row => [row.id, row]));
  return http.createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this read-only server' } });
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (['/api/incidents', '/api/export.csv', '/api/overview'].includes(url.pathname)) {
        const exporting = url.pathname === '/api/export.csv';
        const query = parseQuery(url.searchParams, exporting);
        const matches = matching(rows, query);
        if (url.pathname === '/api/overview') return json(response, 200, overview(matches));
        if (exporting) {
          response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="incidents.csv"', 'Cache-Control': 'no-store' });
          return response.end([fields.join(','), ...matches.map(row => fields.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n');
        }
        const totalPages = Math.ceil(matches.length / query.pageSize);
        const page = Math.min(query.page, totalPages || 1);
        return json(response, 200, { items: matches.slice((page - 1) * query.pageSize, page * query.pageSize), page, pageSize: query.pageSize, total: matches.length, totalPages, summary: summary(matches) });
      }
      if (url.pathname.startsWith('/api/incidents/')) {
        const row = byId.get(decodeURIComponent(url.pathname.slice('/api/incidents/'.length)));
        return row ? json(response, 200, row) : json(response, 404, { error: { code: 'NOT_FOUND', message: 'Incident not found' } });
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: { code: 'NOT_FOUND', message: 'API endpoint not found' } });
      return await servePublic(decodeURIComponent(url.pathname), response);
    } catch (error) {
      const malformed = error instanceof URIError;
      json(response, error.status ?? (malformed ? 400 : 500), { error: { code: error.code === 'INVALID_QUERY' ? error.code : malformed ? 'INVALID_PATH' : 'INTERNAL_ERROR', message: error.status || malformed ? error.message : 'Unable to process request' } });
    }
  });
}
