import { isOwnerId } from './owner'
import { dropOwnerDb } from './owner-db'
import { removeOwnerFiles } from './files'
import { removeOwnerPrefs } from './prefs'

/**
 * Remove one person's map data from this phone: the crew app's
 * account-removal step (rebuild plan §0, shared phones; docs/owner-data.md).
 *
 *  1. Their file folder `maps/<ownerId>/` (Capacitor Filesystem,
 *     LibraryNoCloud in the app; OPFS on the website): imported maps,
 *     originals, tiles.
 *  2. Their settings: localStorage keys `carmanah-maps.<ownerId>.*`.
 *  3. Their database `carmanah-maps.<ownerId>`: layers, features, tracks,
 *     photos, icons, maps library records.
 *
 * Never touches the shared basemap packs (`maps/_packs/`), the shared
 * `carmanah-maps` database (live-fire cache, and the pre-owner backup, which
 * only ever held guest data), or anyone else's data. Every step runs even if
 * an earlier one fails; then it rejects with what failed, so it can be
 * retried. Deleting someone with no data is not an error.
 *
 * Run it with no map page open as that person (or reload the page after);
 * another open map page lets go of the database and reloads.
 */
export async function deleteOwnerData(ownerId: string): Promise<void> {
  if (!isOwnerId(ownerId)) throw new Error(`not an owner id: ${JSON.stringify(ownerId)}`)
  const failed: string[] = []
  const step = async (what: string, run: () => unknown) => {
    try {
      await run()
    } catch (err) {
      failed.push(`${what}: ${(err as Error)?.message ?? err}`)
    }
  }
  await step('files', () => removeOwnerFiles(ownerId))
  await step('settings', () => removeOwnerPrefs(ownerId))
  await step('database', () => dropOwnerDb(ownerId))
  if (failed.length) throw new Error(`couldn't remove all of ${ownerId}'s map data (${failed.join('; ')})`)
}
