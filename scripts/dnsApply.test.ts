import { describe, it, expect } from 'vitest';
import { planZone, wantedRecords } from './dns_apply.mjs';

const zone = 'studentaccount.com';

describe('desired-state DNS', () => {
  it('qualifies names and defaults proxied off for a site zone', () => {
    const want = wantedRecords({ records: [{ type: 'A', name: '@', content: '76.76.21.21' }, { type: 'CNAME', name: 'www', content: 'cname.vercel-dns.com', proxied: false }] }, zone);
    expect(want.map((w) => w.name)).toEqual([zone, `www.${zone}`]);
    expect(want.every((w) => w.proxied === false)).toBe(true);
  });

  it('an alias zone gets two proxied placeholders so the redirect rule has something to fire on', () => {
    const want = wantedRecords({ redirect_to: zone }, 'studentaccount.org');
    expect(want).toEqual([
      { type: 'A', name: 'studentaccount.org', content: '192.0.2.1', proxied: true, ttl: 1 },
      { type: 'A', name: 'www.studentaccount.org', content: '192.0.2.1', proxied: true, ttl: 1 },
    ]);
  });

  it('plans nothing when the zone already matches', () => {
    const want = wantedRecords({ records: [{ type: 'A', name: '@', content: '76.76.21.21' }] }, zone);
    const current = [{ id: 'r1', type: 'A', name: zone, content: '76.76.21.21', proxied: false }];
    expect(planZone(current, want)).toEqual([]);
  });

  it('creates what is missing, updates what differs, and deletes a clashing type', () => {
    const want = wantedRecords({ records: [
      { type: 'A', name: '@', content: '76.76.21.21' },
      { type: 'CNAME', name: 'www', content: 'cname.vercel-dns.com' },
    ] }, zone);
    const current = [
      { id: 'r1', type: 'A', name: zone, content: '104.21.52.10', proxied: true },
      { id: 'r2', type: 'A', name: `www.${zone}`, content: '104.21.52.10', proxied: true },
      { id: 'r3', type: 'TXT', name: zone, content: 'v=spf1 ~all' },
    ];
    const plan = planZone(current, want);
    expect(plan.map((p) => [p.op, p.record.type, p.record.name])).toEqual([
      ['update', 'A', zone],
      ['create', 'CNAME', `www.${zone}`],
      ['delete', 'A', `www.${zone}`],
    ]);
    expect(plan.find((p) => p.op === 'update')?.id).toBe('r1');
    // the TXT record is not ours to touch
    expect(plan.some((p) => p.record.type === 'TXT')).toBe(false);
  });

  it('a proxied flag alone is a change', () => {
    const want = wantedRecords({ records: [{ type: 'A', name: '@', content: '76.76.21.21', proxied: false }] }, zone);
    const current = [{ id: 'r1', type: 'A', name: zone, content: '76.76.21.21', proxied: true }];
    expect(planZone(current, want)).toEqual([{ op: 'update', record: want[0], id: 'r1' }]);
  });
});
