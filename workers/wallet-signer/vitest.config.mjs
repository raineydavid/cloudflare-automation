// Stops vitest walking UP to the repo-root vite.config.ts.
//
// `npx vitest run` in this directory found no local config, climbed to
// the root one, and died on `Cannot find package 'vite'` — the root's
// node_modules is not installed in this job, and does not need to be.
// The worker has its own package.json precisely because viem lives only
// here (AGENTS.md documents the same trap in the other direction: a
// stale node_modules here once made these tests pass locally while CI
// failed).
//
// An empty config is the whole fix: its existence pins the search root.
export default {
  test: {
    include: ['*.test.mjs'],
  },
};
