/**
 * Single source of truth for the running build. Printed as the first line of
 * every boot so the Render log always answers "which commit is live?", and shown
 * in the footer of every page so a user reporting a bug can name the build.
 *
 * Bump rules:
 *   - PATCH (V.01 -> V.02): bug fixes, wording, refactors, no behaviour change.
 *   - MINOR (V.01 -> V.11): a new feature, page, table or integration.
 *   - MAJOR (V.01 -> V.1.0): a breaking change, a new required env var, or any
 *     schema change that needs a manual step on the host.
 *
 * The scheme is deliberately not semantic versioning, and it is not changed on
 * the fly: the boot banner is the reference used to match a report to a deploy,
 * and renumbering would silently desynchronise it from every log already written.
 */
export const SITE_VERSION = 'FPCS-WEB V.12';

export function printVersionBanner() {
  console.log('========================================');
  console.log(`  ${SITE_VERSION}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log('========================================');
}
