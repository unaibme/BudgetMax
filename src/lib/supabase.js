const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
  supabaseAnonKey &&
  !supabaseUrl.includes('your-project-ref') &&
  !supabaseAnonKey.includes('your-anon') &&
  !supabaseAnonKey.includes('your-publishable')
)

let clientPromise = null

export async function getSupabaseClient() {
  if (!isSupabaseConfigured) return null

  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(({ createClient }) => createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      },
      realtime: {
        params: { eventsPerSecond: 5 }
      },
      global: {
        headers: { 'x-application-name': 'pkr-budget-pwa-nologin' }
      }
    }))
  }

  return clientPromise
}
