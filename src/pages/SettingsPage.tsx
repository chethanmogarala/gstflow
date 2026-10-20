import { useEffect, useState, type FormEvent } from 'react'
import { errorText, useToast } from '../components/ui'
import { useFirm } from '../lib/session'
import { db } from '../lib/supabase'
import type { Member } from '../lib/types'

interface Invite { email: string; role: string; created_at: string }

export default function SettingsPage() {
  const { firm, member, refreshFirm } = useFirm()
  const toast = useToast()
  const isAdmin = member.role === 'admin'
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'staff' | 'admin'>('staff')
  const [firmName, setFirmName] = useState(firm.name)

  async function load() {
    const { data: m } = await db().from('firm_members').select('firm_id,user_id,email,role').eq('firm_id', firm.id)
    setMembers(m ?? [])
    if (isAdmin) {
      const { data: i } = await db().from('firm_invites').select('email,role,created_at').eq('firm_id', firm.id)
      setInvites(i ?? [])
    }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function invite(e: FormEvent) {
    e.preventDefault()
    const { error } = await db().from('firm_invites').insert({ firm_id: firm.id, email: email.trim().toLowerCase(), role })
    if (error) { toast(errorText(error)); return }
    toast('Invite saved. They join when they sign up or sign in with that email.')
    setEmail('')
    load()
  }

  async function removeInvite(addr: string) {
    await db().from('firm_invites').delete().eq('firm_id', firm.id).eq('email', addr)
    load()
  }

  async function removeMember(m: Member) {
    const { error } = await db().from('firm_members').delete().eq('firm_id', firm.id).eq('user_id', m.user_id)
    if (error) { toast(errorText(error)); return }
    load()
  }

  async function rename(e: FormEvent) {
    e.preventDefault()
    const { error } = await db().from('firms').update({ name: firmName.trim() }).eq('id', firm.id)
    if (error) { toast(errorText(error)); return }
    await refreshFirm()
    toast('Firm name saved')
  }

  return (
    <>
      <div className="head"><div><div className="eyebrow">{firm.name}</div><h1>Team and settings</h1></div></div>

      <section className="panel">
        <div className="panel-head"><h2>Team</h2></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Email</th><th>Role</th><th /></tr></thead>
          <tbody>
            {members.map(m => (
              <tr key={m.user_id}><td>{m.email}</td><td>{m.role}</td>
                <td className="r">{isAdmin && m.user_id !== member.user_id && <button className="btn sm danger" onClick={() => removeMember(m)}>Remove</button>}</td></tr>
            ))}
            {invites.map(i => (
              <tr key={i.email}><td>{i.email} <span className="tag">invited</span></td><td>{i.role}</td>
                <td className="r"><button className="btn sm" onClick={() => removeInvite(i.email)}>Cancel invite</button></td></tr>
            ))}
          </tbody>
        </table></div>
        {isAdmin && (
          <form className="panel-body" onSubmit={invite} style={{ borderTop: '1px solid var(--line)' }}>
            <div className="form-row">
              <label className="field">Invite by email<input id="invite-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
              <label className="field">Role<select id="invite-role" value={role} onChange={e => setRole(e.target.value as 'staff' | 'admin')}><option value="staff">Staff</option><option value="admin">Admin</option></select></label>
              <button className="btn primary">Add invite</button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>No email is sent. Share the app link; they join this firm when they create an account with this address.</p>
          </form>
        )}
      </section>

      {isAdmin && (
        <form className="panel" onSubmit={rename}>
          <div className="panel-head"><h2>Firm name</h2></div>
          <div className="panel-body"><div className="form-row">
            <label className="field">Name<input id="firm-name" required value={firmName} onChange={e => setFirmName(e.target.value)} /></label>
            <button className="btn">Save</button>
          </div></div>
        </form>
      )}
    </>
  )
}
