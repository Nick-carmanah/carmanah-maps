import { useSyncExternalStore } from 'react'
import { getUnitSettings, subscribeUnitSettings, type UnitSettings } from '../lib/units'

/** Current unit settings; re-renders the component when any of them changes. */
export function useUnitSettings(): UnitSettings {
  return useSyncExternalStore(subscribeUnitSettings, getUnitSettings)
}
