import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase } from './fakeSupabase'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** Demo mode keeps everything in memory in this browser tab. */
export const isDemo = import.meta.env.VITE_DEMO === '1'

/** Null until the Supabase project URL and anon key are set at build time. */
export const supabase: SupabaseClient | null = isDemo
  ? createFakeSupabase()
  : url && anonKey ? createClient(url, anonKey) : null

export function db(): SupabaseClient {
  if (!supabase) throw new Error('Supabase is not configured')
  return supabase
}
