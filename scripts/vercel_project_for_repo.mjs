#!/usr/bin/env node
/**
 * Which Vercel project deploys a given GitHub repo?
 *
 *   vercel_project_for_repo.mjs <owner/name> [search]
 *   → prints the project id on stdout, nothing when none matches
 *
 * Env: VERCEL_TOKEN, optional VERCEL_ORG_ID (a team_… id scopes the
 * search to that team), optional VERCEL_API_URL for tests.
 *
 * A project linked to exactly that repo wins; a project simply NAMED like
 * the search term is the fallback, because Lovable-created projects are
 * often linked after the fact.
 */

const API = (process.env.VERCEL_API_URL || 'https://api.vercel.com').replace(/\/$/, '');
const TOKEN = (process.env.VERCEL_TOKEN || '').trim();
const TEAM = (process.env.VERCEL_ORG_ID || '').trim();

/** Pick the project for a repo out of a projects listing. */
export function pickProject(projects, repo, search) {
  const [owner, name] = String(repo).toLowerCase().split('/');
  const link = (p) => p.link || {};
  const linked = projects.filter((p) => String(link(p).repo || '').toLowerCase() === name && String(link(p).org || '').toLowerCase() === owner);
  const byName = projects.filter((p) => p.name === search);
  return (linked[0] || byName[0]) ?? null;
}

export async function projectFor(repo, search) {
  const qs = new URLSearchParams({ search, limit: '20' });
  if (/^team_/.test(TEAM)) qs.set('teamId', TEAM);
  const r = await fetch(`${API}/v9/projects?${qs}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`projects list → ${r.status}: ${(d.error && d.error.code) || 'failed'}`);
  return pickProject(d.projects || [], repo, search);
}

if (process.argv[1] && process.argv[1].endsWith('vercel_project_for_repo.mjs')) {
  const [repo, search] = process.argv.slice(2);
  if (!TOKEN || !repo) { console.error('VERCEL_TOKEN or repo missing'); process.exit(1); }
  projectFor(repo, search || repo.split('/')[1])
    .then((p) => { if (p) { console.error(`[vercel] ${repo} → project ${p.name}`); console.log(p.id); } else console.error(`[vercel] no project linked to ${repo}`); })
    .catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
