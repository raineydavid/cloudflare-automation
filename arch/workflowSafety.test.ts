/**
 * Editing a file must not spend money or touch production, and a
 * commit-back must not lose a race.
 *
 * All three rules are here because all three were broken, and the third
 * one hid the first.
 *
 * ## Rule 1 — a workflow with a paid key does not trigger on itself
 *
 * A `push:` trigger listing the workflow's OWN path means editing the
 * YAML runs the job. For a job holding a Runway or Runware key, that
 * makes a one-line edit a purchase. It cost real credits twice:
 * `mint_roster.py` set off `mint-team`, and an actions-version bump set
 * off `gen-showcase` and `verify-transform-reveal` together.
 *
 * The tell is that this reads as a *convenience*. Re-running a job when
 * you change it is exactly right for a workflow that compiles or
 * deploys, and exactly wrong for one that buys inference — and the two
 * look identical in a diff. So the rule is scoped to what the workflow
 * is handed: hold a paid key, and you are dispatch-or-input-driven.
 *
 * Deploy workflows are exempt BY NAME below, because redeploying when
 * the deploy definition changes is the point of a deploy workflow, and
 * the keys they carry are passed through to the deployed service rather
 * than spent by the runner. The exemption is a list rather than a
 * pattern so that adding one is a decision somebody makes on purpose.
 *
 * ## Rule 2 — a workflow aimed at production does not trigger on push
 *
 * Rule 1 catches the money and misses the founder's actual constraint,
 * which is about traffic: "you arn't allowed to test on a live site".
 * `launch-readiness.yml` had a push trigger and an origin defaulting to
 * `https://ontold.com`, and a push run carries no inputs — so editing
 * the workflow fired its whole suite at the production apex. Detail
 * below.
 *
 * ## Rule 3 — commit-backs go through the retry helper
 *
 * Sixteen workflows pushed generated assets back with
 * `git push || (git pull --rebase && git push)` — a single retry. On
 * 2026-07-27 two of them failed on that line while a developer pushed
 * commits alongside them. Both had already paid for their renders; one
 * had already uploaded the finished clip as an artifact. The run went
 * red for a reason having nothing to do with the change that triggered
 * it, and the generated work was dropped.
 *
 * That combination — expensive, unrelated, and repeatable — is what
 * teaches people to ignore a workflow going red, which is how a real
 * failure gets missed later. `scripts/git_push_retry.sh` fixes it once.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const ROOT = join(__dirname, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const read = (f: string) => readFileSync(join(WORKFLOWS, f), 'utf-8');

/** Secret-name fragments that mean "this job can buy inference". */
const PAID_KEY = /secrets\.[A-Z0-9_]*(RUNWAY|RUNWARE|GEMINI|OPENROUTER|OPENAI|ANTHROPIC|RUNPOD|ELEVEN|LIVEKIT)[A-Z0-9_]*/;

/**
 * Redeploying when the deploy definition changes is the point of a
 * deploy workflow; the keys they hold are handed to the deployed
 * service, not spent by the runner. Named individually so that adding
 * one is a decision, not a regex that quietly grows.
 */
const SELF_TRIGGER_ALLOWED = new Set([
  'deploy-live-agent.yml',
  'deploy-site-host.yml',
  'deploy-wallet-signer.yml',
]);

/** The one-liner that loses to any concurrent push. */
const FRAGILE_PUSH = 'git pull --rebase && git push';

describe('workflows do not spend money on a diff', () => {
  it('no paid-key workflow triggers on a push to its own file', () => {
    const offenders = files.filter((f) => {
      if (SELF_TRIGGER_ALLOWED.has(f)) return false;
      const body = read(f);
      if (!PAID_KEY.test(body)) return false;
      const doc = parse(body) as { on?: { push?: { paths?: string[] } } };
      const paths = doc?.on?.push?.paths ?? [];
      return paths.some((p) => p === `.github/workflows/${f}`);
    });
    expect(offenders, 'editing these would buy inference').toEqual([]);
  });

  it('a push trigger never has an empty paths list', () => {
    // Removing a self-path can leave `paths:` with nothing under it,
    // which does not mean "never" — it widens the trigger to every
    // push, the opposite of the fix.
    const offenders = files.filter((f) => {
      const doc = parse(read(f)) as { on?: { push?: { paths?: unknown } } };
      const push = doc?.on?.push;
      if (!push || typeof push !== 'object') return false;
      return 'paths' in push && (push.paths == null || (Array.isArray(push.paths) && push.paths.length === 0));
    });
    expect(offenders, 'an empty paths list fires on every push').toEqual([]);
  });
});

describe('workflows do not send traffic at production on a diff', () => {
  /**
   * The money rule above missed this axis entirely, and the founder's
   * standing constraint is about this one: "you arn't allowed to test on
   * a live site".
   *
   * `launch-readiness.yml` held a push trigger and a
   * `https://ontold.com` default. A push run carries no inputs, so the
   * origin fell through to that default — editing the workflow fired the
   * whole suite at the production apex, including a POST to
   * `/api/ai?action=chat` that spends inference. A branch filter kept
   * the blast radius small, but it pinned an old branch name; that is
   * incidental protection, not a decision.
   *
   * Same reasoning as `autonomous-ops.yml`: a schedule is deliberate
   * monitoring a human set up, a dispatch is a human asking, and a push
   * is neither.
   *
   * Scoped to the production apex on purpose. Preview and branch URLs
   * are what CI is for — `probe-deploy.yml` GETs a preview deployment
   * on a file push and that is a legitimate file-as-dispatch pattern.
   */
  const PRODUCTION_HOST = /https:\/\/(www\.)?ontold\.com/;

  it('no workflow targeting the production apex runs on an incidental push', () => {
    // The rule used to forbid `push:` outright, which is a proxy for what
    // it actually cares about: a run nobody asked for. `launch-readiness`
    // had a push trigger and no inputs, so editing the file fired a POST
    // at the apex — that is the failure, and "somebody edited this file"
    // is not "somebody wanted a run".
    //
    // A push watching ONLY `.github/dispatch-requests/` is the opposite:
    // it fires when somebody commits a file whose entire purpose is to
    // ask. That is this repo's own idiom for exactly this, and it is what
    // keeps these runnable at all — workflow_dispatch resolves only
    // against the default branch, which here is eight months behind.
    //
    // Refined rather than relaxed: a workflow's own path, a branch, or a
    // source directory still fails.
    const offenders = files.filter((f) => {
      const body = read(f);
      if (!PRODUCTION_HOST.test(body)) return false;
      const doc = parse(body) as { on?: Record<string, unknown> };
      if (doc?.on == null || typeof doc.on !== 'object' || !('push' in doc.on)) return false;
      const push = (doc.on as { push?: { paths?: string[] } }).push;
      const paths = push?.paths ?? [];
      // No paths at all means every push, which is the worst case.
      if (paths.length === 0) return true;
      return !paths.every((p) => p.startsWith('.github/dispatch-requests/'));
    });
    expect(
      offenders,
      'a push must not send traffic at ontold.com unless it is a dispatch request',
    ).toEqual([]);
  });
});

describe('commit-backs survive a concurrent push', () => {
  it('the retry helper exists', () => {
    expect(existsSync(join(ROOT, 'scripts', 'git_push_retry.sh'))).toBe(true);
  });

  it('no workflow uses the single-retry one-liner', () => {
    const offenders = files.filter((f) => read(f).includes(FRAGILE_PUSH));
    expect(offenders, 'use scripts/git_push_retry.sh instead').toEqual([]);
  });

  it('every workflow that pushes a commit-back uses the helper', () => {
    const offenders = files.filter((f) => {
      const body = read(f);
      // A commit-back is a `git commit` followed by a `git push` in the
      // same file. Workflows that only read, or only tag, are not it.
      if (!/git commit/.test(body)) return false;
      if (!/git push/.test(body)) return false;
      // A PR flow is NOT a commit-back and must not use the helper.
      // The helper pushes `HEAD:$GITHUB_REF_NAME` — correct when adding
      // a commit to the branch you are already on, and actively wrong
      // here, where the point is to push a NEW branch and leave the
      // original untouched. Rebase-and-retry is meaningless against a
      // branch that did not exist a second ago, and pointing it at
      // GITHUB_REF_NAME would push the proposed change straight onto
      // the branch the PR was meant to ask about.
      if (/gh pr create/.test(body) && /git checkout -b/.test(body)) return false;
      return !body.includes('scripts/git_push_retry.sh');
    });
    expect(offenders, 'commit-back must push via the helper').toEqual([]);
  });
});

describe('workflows that write a credential into another repository', () => {
  // Found by SHAPE, not by name. The first version of this guard named
  // one file — which is the same mistake it was written to catch, one
  // level up: a general rule wearing one instance's name, which stops
  // applying the moment a second instance exists and says nothing when
  // it does.
  //
  // The mint was `mint-nationalff-token.yml` and every part agreed: the
  // trigger path, the default target, the token name, the closing
  // notice. Accurate when written, a trap the moment a second property
  // needed it. Pointing it at Screening Studio surfaced three
  // hardcodings in one run, and the dangerous one was the token name —
  // fixed at `nationalff-deploy`, minting for a second repo would have
  // created a token under nationalff's name and the revoke step would
  // then have deleted nationalff's live credential.
  //
  // Anything that writes a secret into a repository it is not running in
  // has the same three obligations, whatever it is called.
  // Narrower than "writes a secret somewhere else", and the distinction
  // is the whole risk. `mint-d1-token.yml` and `mirror-public-domain.yml`
  // both write into a sibling — but each names it as a LITERAL in the
  // workflow (`${ORG}/expert-station`), so redirecting one means editing
  // the workflow, which is the same act as editing an allowlist. They
  // are already constrained and demanding one of them would be
  // ceremony.
  //
  // What needs guarding is a target supplied from OUTSIDE: a dispatch
  // input, or a request file in the tree. That is where "anyone who can
  // land a commit" becomes real.
  const provisioners = files.filter((f) => {
    const src = read(f);
    const writesSecrets = /gh secret set/.test(src) && /--repo/.test(src);
    // Having a request file is not the same as READING the target from
    // one. Both of the workflows above are triggered by a request file
    // and neither takes its destination from it — the first version of
    // this check conflated the two and reported them as unguarded.
    const targetFromOutside =
      /inputs\.repo/.test(src) || /\.get\(['"]repo['"]/.test(src);
    return writesSecrets && targetFromOutside;
  });

  it('there is at least one, or this guard has stopped watching anything', () => {
    // A shape-based rule that matches nothing passes silently forever.
    expect(provisioners.length).toBeGreaterThan(0);
  });

  it.each(provisioners)('%s takes its allowlist from config, not from code', (f) => {
    // This is meant to become infrastructure other people run, so a list
    // of repository names compiled into the workflow is wrong twice
    // over: adding a property becomes a code change, and nobody else can
    // use it without a fork.
    const src = read(f);
    expect(src, `${f} has no allowlist at all`).toMatch(/ALLOWED/);
    // The names themselves must not be in the workflow.
    const inCode = src.match(/raineydavid\/[a-z-]+/g) ?? [];
    const outsideComments = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
      .match(/raineydavid\/[a-z-]+/g) ?? [];
    expect(
      outsideComments,
      `${f} names repositories in code (${inCode.join(', ')}) instead of reading an allowlist`,
    ).toEqual([]);
  });

  it.each(provisioners)('%s fails closed when no allowlist is configured', (f) => {
    // An open default fails silently and totally; a closed one fails
    // once, clearly, the first time somebody uses it.
    const src = read(f);
    expect(src, `${f} does not refuse when the allowlist is empty`).toMatch(
      /fails closed|no repository may be provisioned/i,
    );
  });

  it.each(provisioners)('%s does not default its target', (f) => {
    // A default is how the next caller provisions a repository they did
    // not ask about, and is told it worked.
    const doc = parse(read(f)) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, { default?: string }> } };
      jobs?: Record<string, { env?: Record<string, string> }>;
    };
    // Only inputs that NAME a repository. A branch input legitimately
    // contains a slash, and matching on the slash alone reported
    // `claude/lead-magnet-…` as a defaulted repo — a guard that cries
    // wolf gets switched off.
    for (const [name, input] of Object.entries(doc.on?.workflow_dispatch?.inputs ?? {})) {
      if (!/repo/i.test(name)) continue;
      expect(String(input.default ?? ''), `${f} defaults a target repository`).not.toMatch(/\/\w/);
    }
    for (const job of Object.values(doc.jobs ?? {})) {
      expect(String(job.env?.TARGET ?? ''), `${f} hardcodes TARGET`).not.toMatch(/\/\w/);
    }
  });

  it.each(provisioners)('%s names what it creates after the target', (f) => {
    // The one that would have revoked another property's live
    // credential. A fixed name means two repositories share one
    // identity, and a revoke-predecessors step cannot tell them apart.
    const src = read(f);
    if (!/TOKEN_NAME/.test(src)) return;
    expect(src, `${f} fixes the token name instead of deriving it`).toMatch(
      /TOKEN_NAME=.*\$\{TARGET/,
    );
    expect(src).not.toMatch(/TOKEN_NAME:\s*[a-z-]+-deploy/);
  });

  it.each(provisioners)('%s is not named for a single repository', (f) => {
    // The name is what made every other hardcoding read as correct.
    expect(f).not.toMatch(/nationalff|screening|ontold/);
  });
});
