#!/usr/bin/env node
/**
 * Desired-state DNS for one zone: audit, diff, and (only when asked) apply.
 *
 *   dns_apply.mjs <zone> [--apply] [--repo owner/name]
 *
 * The desired state lives in data/dns/<zone>.json:
 *
 *   { "records": [{ "type": "A", "name": "@", "content": "76.76.21.21", "proxied": false }],
 *     "redirect_to": "studentaccount.com",          // alias zone: 301 everything there
 *     "vercel": { "repo": "raineydavid/bounty-ai-craft", "attach": ["@", "www"] } }
 *
 * Keyless half: public DNS (NS, A, CNAME) and what each https host actually
 * answers — a Vercel-served page carries x-vercel-id, a Cloudflare challenge
 * carries cf-mitigated, and the first bytes of the body tell a Vercel
 * DEPLOYMENT_NOT_FOUND from a Cloudflare error page.
 *
 * Credentialed half (CLOUDFLARE_API_TOKEN): the zone's records, SSL mode and
 * the diff against the desired state. --apply writes that diff — records,
 * the redirect rule for an alias zone, SSL strict when a proxied record
 * needs it — and nothing else. Cloudflare's errors are redacted before
 * printing; the token never is.
 *
 * Vercel half (VERCEL_TOKEN + --repo or vercel.repo): whether the domain is
 * attached to the project that deploys the repo; --apply attaches apex and
 * www (www 308 -> apex) and prints any TXT Vercel wants for verification.
 *
 * Exit 0 for a survey; 1 only when --apply was asked for and a write failed.
 */
import { Resolver } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { pickProject } from './vercel_project_for_repo.mjs';

const args = process.argv.slice(2);
const ZONE = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();
const APPLY = args.includes('--apply');
const REPO_ARG = args[args.indexOf('--repo') + 1] && args.includes('--repo') ? args[args.indexOf('--repo') + 1] : '';
const TOKEN = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
const API = process.env.CF_API_URL || 'https://api.cloudflare.com/client/v4';
const VAPI = (process.env.VERCEL_API_URL || 'https://api.vercel.com').replace(/\/$/, '');

const CF_IP = /^(104\.(1[6-9]|2[0-9]|3[01])\.|172\.6[4-9]\.|172\.7[01]\.|173\.245\.|188\.114\.|141\.101\.|162\.15[89]\.|190\.93\.|197\.234\.|198\.41\.)/;
const redact = (s) => String(s).replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 200);
const fqdn = (name, zone) => (name === '@' ? zone : `${name}.${zone}`);

/** The desired records for a zone spec, fully qualified. */
export function wantedRecords(spec, zone) {
  const rows = spec.records ?? (spec.redirect_to ? [
    { type: 'A', name: '@', content: '192.0.2.1', proxied: true },
    { type: 'A', name: 'www', content: '192.0.2.1', proxied: true },
  ] : []);
  return rows.map((r) => ({ ...r, name: fqdn(r.name, zone), proxied: Boolean(r.proxied), ttl: r.ttl ?? 1 }));
}

/** What has to change to get from `current` to `want`. Pure, so it is tested. */
export function planZone(current, want) {
  const plan = [];
  for (const w of want) {
    const same = current.find((r) => r.type === w.type && r.name === w.name);
    if (!same) plan.push({ op: 'create', record: w });
    else if (String(same.content).toLowerCase() !== String(w.content).toLowerCase() || Boolean(same.proxied) !== w.proxied) plan.push({ op: 'update', record: w, id: same.id });
  }
  // A CNAME and an A record cannot share a name; an apex CNAME or a stale AAAA on www must go.
  for (const w of want) {
    for (const r of current) {
      if (r.name === w.name && r.type !== w.type && ['A', 'AAAA', 'CNAME'].includes(r.type)) plan.push({ op: 'delete', record: r, id: r.id });
    }
  }
  return plan;
}

async function head(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 dns-apply', accept: 'text/html,*/*' }, signal: AbortSignal.timeout(20000) });
    const h = (k) => res.headers.get(k);
    const body = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    return `${res.status}${h('location') ? ` -> ${h('location')}` : ''}  server=${h('server') ?? '-'}  vercel=${h('x-vercel-id') ? 'yes' : 'no'}${h('cf-mitigated') ? `  cf-mitigated=${h('cf-mitigated')}` : ''}${h('x-vercel-error') ? `  vercel-error=${h('x-vercel-error')}` : ''}\n${''.padEnd(30)}body: ${body || '<empty>'}`;
  } catch (e) { return `unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.cause?.code ?? e.message})`; }
}

async function publicDns(zone) {
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const q = async (name, type) => { try { return (await resolver.resolve(name, type)).flat().map(String); } catch (e) { return e.code === 'ENODATA' || e.code === 'ENOTFOUND' ? [] : [`error:${e.code}`]; } };
  console.log('=== Public DNS (no credential needed) ===');
  const ns = await q(zone, 'NS');
  console.log(`NS: ${ns.join(' ') || '<none — not delegated>'}${ns.some((n) => /ns\.cloudflare\.com$/i.test(n)) ? '  => on Cloudflare' : ns.length ? '  => NOT on Cloudflare' : ''}`);
  for (const host of [zone, `www.${zone}`]) {
    const a = await q(host, 'A'), cname = await q(host, 'CNAME');
    console.log(`${host.padEnd(28)} A=${a.join(',') || '-'}  CNAME=${cname.join(',') || '-'}${a.some((ip) => CF_IP.test(ip)) ? '  (Cloudflare proxy, orange cloud)' : a.includes('76.76.21.21') ? '  (Vercel apex, DNS-only)' : ''}`);
    if (a.length || cname.length) console.log(`${''.padEnd(28)} https://${host} -> ${await head(`https://${host}/`)}`);
  }
}

const cf = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.success !== false, status: res.status, body };
};

async function cloudflare(zone, spec) {
  console.log('\n=== Cloudflare ===');
  if (!TOKEN) { console.log('(no CLOUDFLARE_API_TOKEN — records cannot be read or written from here)'); return 0; }
  const zones = await cf(`/zones?name=${encodeURIComponent(zone)}`);
  const z = zones.body.result?.[0];
  if (!z) { console.log(`zone ${zone}: NOT visible to this token (${zones.status})`); return APPLY ? 1 : 0; }
  console.log(`zone ${zone}: ${z.status}`);
  const ssl = await cf(`/zones/${z.id}/settings/ssl`);
  console.log(`ssl mode=${ssl.body.result?.value ?? '?'}`);
  const recs = await cf(`/zones/${z.id}/dns_records?per_page=100`);
  const current = recs.body.result ?? [];
  for (const r of current) console.log(`  have  ${r.type.padEnd(5)} ${r.name.padEnd(30)} ${String(r.content).padEnd(28)} ${r.proxied ? 'proxied' : 'dns-only'}`);
  const want = wantedRecords(spec, zone);
  const plan = planZone(current, want);
  if (plan.length === 0) console.log('  records: match desired state');
  for (const p of plan) console.log(`  ${APPLY ? 'apply ' : 'would '}${p.op.padEnd(6)} ${p.record.type.padEnd(5)} ${p.record.name.padEnd(30)} ${String(p.record.content).padEnd(28)} ${p.record.proxied ? 'proxied' : 'dns-only'}`);

  let failures = 0;
  if (spec.redirect_to) {
    const rules = await cf(`/zones/${z.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`);
    const existing = (rules.body.result?.rules ?? []).find((r) => r.description === `canonical redirect to ${spec.redirect_to}`);
    console.log(`  redirect rule -> https://${spec.redirect_to}: ${existing ? 'present' : rules.ok || rules.status === 404 ? (APPLY ? 'apply create' : 'would create') : `unreadable (${rules.status})`}`);
    if (APPLY && !existing) {
      const rule = { description: `canonical redirect to ${spec.redirect_to}`, expression: 'true', action: 'redirect', enabled: true,
        action_parameters: { from_value: { status_code: 301, target_url: { expression: `concat("https://${spec.redirect_to}", http.request.uri.path)` }, preserve_query_string: true } } };
      const put = rules.body.result?.id
        ? await cf(`/zones/${z.id}/rulesets/${rules.body.result.id}/rules`, { method: 'POST', body: JSON.stringify(rule) })
        : await cf(`/zones/${z.id}/rulesets`, { method: 'POST', body: JSON.stringify({ name: 'default', kind: 'zone', phase: 'http_request_dynamic_redirect', rules: [rule] }) });
      console.log(`    ${put.ok ? 'created' : `FAILED: ${redact(JSON.stringify(put.body.errors ?? put.status))}`}`); if (!put.ok) failures++;
    }
  }
  if (APPLY) {
    for (const p of plan) {
      const payload = JSON.stringify({ type: p.record.type, name: p.record.name, content: p.record.content, proxied: p.record.proxied, ttl: p.record.ttl ?? 1 });
      const res = p.op === 'create' ? await cf(`/zones/${z.id}/dns_records`, { method: 'POST', body: payload })
        : p.op === 'update' ? await cf(`/zones/${z.id}/dns_records/${p.id}`, { method: 'PUT', body: payload })
        : await cf(`/zones/${z.id}/dns_records/${p.id}`, { method: 'DELETE' });
      console.log(`    ${p.op} ${p.record.type} ${p.record.name}: ${res.ok ? 'done' : `FAILED: ${redact(JSON.stringify(res.body.errors ?? res.status))}`}`); if (!res.ok) failures++;
    }
    if (want.some((w) => w.proxied) && ssl.body.result?.value && ssl.body.result.value !== 'strict') {
      const set = await cf(`/zones/${z.id}/settings/ssl`, { method: 'PATCH', body: JSON.stringify({ value: 'strict' }) });
      console.log(`    ssl mode -> strict: ${set.ok ? 'done' : `FAILED: ${redact(JSON.stringify(set.body.errors ?? set.status))}`}`); if (!set.ok) failures++;
    }
  }
  return failures;
}

async function vercel(zone, spec) {
  const repo = REPO_ARG || spec.vercel?.repo || '';
  const vt = (process.env.VERCEL_TOKEN || '').trim(), team = (process.env.VERCEL_ORG_ID || '').trim();
  console.log('\n=== Vercel ===');
  if (!repo) { console.log('(no repo named — skipped)'); return 0; }
  if (!vt) { console.log('(no VERCEL_TOKEN — cannot see whether the domain is on the project)'); return 0; }
  const qs = team.startsWith('team_') ? `?teamId=${encodeURIComponent(team)}` : '';
  const v = async (path, init = {}) => { const res = await fetch(`${VAPI}${path}${qs}`, { ...init, headers: { authorization: `Bearer ${vt}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000) }); return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }; };
  const search = repo.split('/')[1];
  const list = await v(`/v9/projects${qs ? '&' : '?'}search=${encodeURIComponent(search)}&limit=20`.replace(/^\/v9\/projects&/, '/v9/projects?'));
  const project = list.ok ? pickProject(list.body.projects ?? [], repo, search) : null;
  if (!project) { console.log(`no Vercel project linked to ${repo} (${list.status})`); return 0; }
  console.log(`project ${project.name} deploys ${repo}`);
  const doms = await v(`/v9/projects/${project.id}/domains`);
  const have = new Map((doms.body.domains ?? []).map((d) => [d.name, d]));
  for (const d of have.values()) console.log(`  have  ${d.name.padEnd(30)} verified=${d.verified}${d.redirect ? `  redirect -> ${d.redirect}` : ''}`);
  const names = (spec.vercel?.attach ?? ['@', 'www']).map((n) => fqdn(n, zone));
  let failures = 0;
  for (const name of names) {
    if (have.has(name)) continue;
    const body = name === zone ? { name } : { name, redirect: zone, redirectStatusCode: 308 };
    console.log(`  ${APPLY ? 'apply add' : 'would add'} ${name}${body.redirect ? ` (308 -> ${body.redirect})` : ''}`);
    if (!APPLY) continue;
    const add = await v(`/v10/projects/${project.id}/domains`, { method: 'POST', body: JSON.stringify(body) });
    console.log(`    ${add.ok ? 'added' : `FAILED: ${redact(JSON.stringify(add.body.error ?? add.status))}`}`); if (!add.ok) failures++;
  }
  for (const name of names) {
    const d = await v(`/v9/projects/${project.id}/domains/${name}`);
    for (const ver of d.body.verification ?? []) console.log(`  verification for ${name}: ${ver.type} ${ver.domain} = ${ver.value}`);
  }
  return failures;
}

if (process.argv[1] && process.argv[1].endsWith('dns_apply.mjs')) {
  if (!ZONE) { console.error('usage: dns_apply.mjs <zone> [--apply] [--repo owner/name]'); process.exit(1); }
  const spec = JSON.parse(await readFile(new URL(`../data/dns/${ZONE}.json`, import.meta.url), 'utf8'));
  await publicDns(ZONE);
  const failures = (await cloudflare(ZONE, spec)) + (await vercel(ZONE, spec));
  if (!APPLY) console.log('\nDry run. Set "apply": true in .github/dispatch-requests/dns-apply.json to write the diff above.');
  process.exit(failures ? 1 : 0);
}
