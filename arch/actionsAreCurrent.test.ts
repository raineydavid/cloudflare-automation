/**
 * One action, one major, across every workflow. "Latest" needs the
 * network (scripts/bump_actions.py, weekly); this catches the drift
 * that actually happens — the same action pinned two ways — offline.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const DIR = join(ROOT, '.github', 'workflows');
const files = readdirSync(DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

/** `uses: owner/repo@ref`. */
const USES = /^\s*-?\s*uses:\s*([\w.-]+\/[\w.-]+)@([\w.-]+)/;
/** A floating major tag — the only kind this rewrites or judges. */
const MAJOR = /^v\d+$/;

interface Pin { action: string; ref: string; file: string }

const pins: Pin[] = files.flatMap(f =>
  readFileSync(join(DIR, f), 'utf8').split('\n').flatMap(line => {
    const m = USES.exec(line);
    return m ? [{ action: m[1], ref: m[2], file: f }] : [];
  }));

describe('workflow actions', () => {
  it('finds pins at all', () => {
    // Without this the checks below are vacuous — a regex that stopped
    // matching would report a clean repo.
    expect(pins.length, 'no `uses:` lines parsed — the matcher broke').toBeGreaterThan(10);
  });

  it('pins each action at ONE major across the repo', () => {
    const byAction = new Map<string, Map<string, string[]>>();
    for (const p of pins) {
      if (!MAJOR.test(p.ref)) continue;   // SHA / branch / patch pin: deliberate
      const refs = byAction.get(p.action) ?? new Map<string, string[]>();
      refs.set(p.ref, [...(refs.get(p.ref) ?? []), p.file]);
      byAction.set(p.action, refs);
    }
    const split = [...byAction.entries()]
      .filter(([, refs]) => refs.size > 1)
      .map(([action, refs]) => `${action}: ${[...refs.entries()]
        .map(([ref, fs]) => `${ref} in ${fs.join(', ')}`).join('  |  ')}`);
    expect(split, 'run `python3 scripts/bump_actions.py --apply --offline`').toEqual([]);
  });

  it('reads Node from .nvmrc rather than pinning it per workflow', () => {
    // The setup-node README's own recommendation, and it deletes the
    // drift class: ten workflows cannot disagree about a number that
    // only exists once.
    const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
    expect(nvmrc, '.nvmrc is empty').toMatch(/^\d+/);
    const pinned = files.filter(f =>
      /^\s*node-version:\s*['"]?\d/m.test(readFileSync(join(DIR, f), 'utf8')));
    expect(pinned, "use node-version-file: '.nvmrc'").toEqual([]);
  });

  it('every runtime pin is at or above the floor bump_actions holds', () => {
    // The floors live in the script, so this reads them from there
    // rather than restating them — two copies of a version number is
    // how the check and the fixer end up disagreeing.
    const script = readFileSync(join(ROOT, 'scripts', 'bump_actions.py'), 'utf8');
    const block = /RUNTIMES = \{([\s\S]*?)\}/.exec(script);
    expect(block, 'RUNTIMES moved — the fixer and this check must read one list').toBeTruthy();
    const floors = new Map<string, string>();
    for (const m of block![1].matchAll(/"([\w-]+)":\s*"([\d.]+)"/g)) floors.set(m[1], m[2]);
    expect(floors.size).toBeGreaterThan(0);

    const older = (have: string, want: string) => {
      const a = have.split('.').map(Number), b = want.split('.').map(Number);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? 0, y = b[i] ?? 0;
        if (x !== y) return x < y;
      }
      return false;
    };

    const behind: string[] = [];
    for (const f of files) {
      readFileSync(join(DIR, f), 'utf8').split('\n').forEach(line => {
        for (const [key, want] of floors) {
          const m = new RegExp(`^\\s*${key}:\\s*['"]?([\\d.]+)['"]?`).exec(line);
          if (m && older(m[1], want)) behind.push(`${f}: ${key} ${m[1]} < ${want}`);
        }
      });
    }
    expect(behind, 'run `python3 scripts/bump_actions.py --apply --offline`').toEqual([]);
  });
});
