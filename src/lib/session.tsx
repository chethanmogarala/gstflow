import type { Session } from '@supabase/supabase-js'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import type { Firm, Member } from './types'

interface SessionState {
  loading: boolean
  session: Session | null
  email: string
  firm: Firm | null
  member: Member | null
  refreshFirm: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<SessionState | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [firm, setFirm] = useState<Firm | null>(null)
  const [member, setMember] = useState<Member | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshFirm = useCallback(async () => {
    if (!supabase) return
    await supabase.rpc('accept_invites')
    const { data } = await supabase.from('firm_members').select('firm_id,user_id,email,role,firms(id,name)')
      .order('created_at').limit(1).maybeSingle()
    if (data) {
      const f = data.firms as unknown as Firm
      setFirm(f)
      setMember({ firm_id: data.firm_id, user_id: data.user_id, email: data.email, role: data.role })
    } else {
      setFirm(null)
      setMember(null)
    }
  }, [])

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      if (data.session) await refreshFirm()
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'SIGNED_IN') refreshFirm()
      if (event === 'SIGNED_OUT') { setFirm(null); setMember(null) }
    })
    return () => sub.subscription.unsubscribe()
  }, [refreshFirm])

  const signOut = async () => { await supabase?.auth.signOut() }

  return (
    <Ctx.Provider value={{ loading, session, email: session?.user.email ?? '', firm, member, refreshFirm, signOut }}>
      {children}
    </Ctx.Provider>
  )
}

export function useSession() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSession outside SessionProvider')
  return v
}

/** The signed-in firm; only call inside screens that render after firm setup. */
export function useFirm() {
  const s = useSession()
  return { ...s, firm: s.firm!, member: s.member! }
}
