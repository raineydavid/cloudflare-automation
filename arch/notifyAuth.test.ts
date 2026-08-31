/**
 * Which bearers /notify accepts.
 *
 * `MCP_TOKEN || ROOT_SECRET` is the obvious spelling and it fails
 * silently: api/_mail resolves the same pair in the same order on the
 * caller side, so a deployment carrying only ROOT_SECRET presents a
 * real credential and a Worker holding both refuses it. Nothing looks
 * misconfigured. Mail just stops.
 *
 * Tested here rather than beside notify.mjs because that file imports
 * `cloudflare:email`, which resolves only inside the Workers runtime.
 */

import { describe, it, expect } from 'vitest';

import { acceptedBearers, bearerOk } from '../workers/mcp/src/notifyAuth.mjs';

describe('/notify bearers', () => {
  it('accepts EITHER secret when the Worker holds both', () => {
    // The whole point. A caller resolving ROOT_SECRET is not wrong,
    // and refusing it costs every receipt.
    const accepted = acceptedBearers({ MCP_TOKEN: 'mcp', ROOT_SECRET: 'root' });
    expect(bearerOk('Bearer mcp', accepted)).toBe(true);
    expect(bearerOk('Bearer root', accepted)).toBe(true);
  });

  it('still refuses anything else', () => {
    const accepted = acceptedBearers({ MCP_TOKEN: 'mcp', ROOT_SECRET: 'root' });
    for (const bad of ['Bearer nope', 'mcp', 'Bearer  mcp', 'Basic mcp', '']) {
      expect(bearerOk(bad, accepted), bad).toBe(false);
    }
  });

  it('works when only one is configured', () => {
    expect(bearerOk('Bearer root', acceptedBearers({ ROOT_SECRET: 'root' }))).toBe(true);
    expect(bearerOk('Bearer mcp', acceptedBearers({ MCP_TOKEN: 'mcp' }))).toBe(true);
  });

  it('an unconfigured Worker accepts NOTHING, including no header at all', () => {
    // A mail route with no bearer is an open relay: anybody who finds
    // the URL can make our domain write to any address. The empty list
    // must not degrade into "match anything" — which is exactly what a
    // bare `.every()` over an empty array would do.
    const accepted = acceptedBearers({});
    expect(accepted).toEqual([]);
    for (const attempt of ['', 'Bearer ', 'Bearer anything', null, undefined]) {
      expect(bearerOk(attempt as string, accepted)).toBe(false);
    }
  });

  it('whitespace-only configuration is no configuration', () => {
    // An env var set to '' or ' ' reads as configured to every
    // presence check and would otherwise make `Bearer ` a valid
    // credential.
    expect(acceptedBearers({ MCP_TOKEN: '   ', ROOT_SECRET: '' })).toEqual([]);
  });

  it('a surrounding-whitespace secret still matches what a caller sends', () => {
    // A value pasted into a dashboard with a trailing newline is a
    // configuration accident, not a different secret.
    expect(bearerOk('Bearer mcp', acceptedBearers({ MCP_TOKEN: ' mcp\n' }))).toBe(true);
  });
});
