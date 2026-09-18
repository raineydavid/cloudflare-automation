import { describe, it, expect } from 'vitest';
import { pickProject } from './vercel_project_for_repo.mjs';

describe('finding the Vercel project that deploys a repo', () => {
  const projects = [
    { id: 'prj_other', name: 'bounty-ai-craft-old', link: { org: 'someone', repo: 'bounty-ai-craft' } },
    { id: 'prj_named', name: 'bounty-ai-craft' },
    { id: 'prj_linked', name: 'student-account', link: { org: 'RaineyDavid', repo: 'Bounty-AI-Craft' } },
  ];

  it('prefers the project linked to exactly that repo, case-insensitively', () => {
    expect(pickProject(projects, 'raineydavid/bounty-ai-craft', 'bounty-ai-craft')?.id).toBe('prj_linked');
  });

  it('falls back to the project named like the search term', () => {
    expect(pickProject(projects.filter((p) => p.id !== 'prj_linked'), 'raineydavid/bounty-ai-craft', 'bounty-ai-craft')?.id).toBe('prj_named');
  });

  it('returns nothing rather than a wrong project', () => {
    expect(pickProject(projects, 'raineydavid/ontold', 'ontold')).toBeNull();
  });
});
