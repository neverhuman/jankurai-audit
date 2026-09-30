import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Family } from './family-model.mjs';
import { api } from './family-update.mjs';
import { clean, git, gitText, run } from './family-lib.mjs';

try {
  const family = new Family(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const apply = process.argv.includes('--apply');
  if (!apply && !process.argv.includes('--dry-run')) throw new Error('expected --dry-run or --apply');
  for (const repo of family.repos) {
    if (!family.existing(repo)) throw new Error(`missing canonical checkout: ${repo.name}`);
    if (apply) clean(family.path(repo));
  }
  for (const repo of family.repos) {
    // GitHub provisioning addresses the mirror; origin stays on the forge authority.
    const slug = repo.github_slug, directory = family.path(repo);
    console.log(`${slug}: preserve histories; protect ${repo.required_check}`);
    if (!apply) continue;
    const result = run(['gh', 'api', `repos/${slug}`], { capture: true, check: false });
    if (result.status !== 0) {
      if (!result.stderr.includes('HTTP 404') || repo.name === 'jankurai') throw new Error(result.stderr);
      api('user/repos', { name: slug.split('/')[1], private: false, auto_init: false });
      const refs = gitText(directory, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags').split('\n');
      git(directory, ['push', '--atomic', repo.github, ...refs.map(ref => `${ref}:${ref}`)]);
    }
    api(`repos/${slug}/branches/main/protection`, {
      required_status_checks: { strict: true, contexts: [repo.required_check] }, enforce_admins: true, restrictions: null,
      required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true },
      required_linear_history: true, allow_force_pushes: false, allow_deletions: false, required_conversation_resolution: true,
    }, 'PUT');
    api(`repos/${slug}`, { allow_auto_merge: true, allow_squash_merge: true }, 'PATCH');
    if (!api(`repos/${slug}/rulesets`).some(rule => rule.name === 'Immutable dependency and CI tags')) {
      api(`repos/${slug}/rulesets`, { name: 'Immutable dependency and CI tags', target: 'tag', enforcement: 'active',
        conditions: { ref_name: { include: ['~ALL'], exclude: [] } }, rules: [{ type: 'deletion' }, { type: 'update' }] });
    }
    if (gitText(directory, 'remote', 'get-url', 'origin') !== repo.hosted) {
      if (gitText(directory, 'remote').split('\n').includes('github')) throw new Error(`${slug}: inspect existing historical remote before changing origin`);
      git(directory, ['remote', 'rename', 'origin', 'github']);
      git(directory, ['remote', 'add', 'origin', repo.hosted]);
    }
  }
} catch (error) { console.error(`provision-family: ${error.message}`); process.exitCode = 1; }
