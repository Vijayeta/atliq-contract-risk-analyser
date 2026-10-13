import type { ReactNode } from 'react'
import { useState } from 'react'
import { Home, FileText, Wallet, History, ShieldCheck, Users, Search, Upload, ChevronDown, Settings as SettingsIcon, CircleHelp, Clock } from 'lucide-react'
import { users, userIds, type UserId } from './data'
import { Avatar } from './ui'
import { NotificationsMenu } from './overlays'
import type { AppNotification } from './hax'

export type View = 'overview' | 'reviews' | 'register' | 'precedent' | 'audit' | 'team' | 'submit' | 'review' | 'settings'

const WORKSPACE: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'overview', label: 'Overview', icon: Home },
  { id: 'reviews', label: 'Contract reviews', icon: FileText },
  { id: 'register', label: 'Obligation register', icon: Wallet },
  { id: 'precedent', label: 'Precedent search', icon: History },
]

const MANAGE: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'audit', label: 'Audit log', icon: ShieldCheck },
  { id: 'team', label: 'Team & delegation', icon: Users },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
]

export function Sidebar({
  view,
  setView,
  open,
  badge,
}: {
  view: View
  setView: (v: View) => void
  open: boolean
  badge: number
}) {
  const isActive = (id: View) => view === id || (id === 'reviews' && view === 'review')

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-30 flex w-[260px] flex-col bg-[#111c38] transition-transform duration-200 lg:translate-x-0 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex items-center gap-3 px-6 pb-6 pt-6">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#2f6fe4] text-[15px] font-bold text-white">A</span>
        <span className="leading-tight">
          <span className="block text-[17px] font-bold tracking-[0.18em] text-white">ATLIQ</span>
          <span className="block text-[10px] font-medium tracking-wide text-white/45">Contract Risk Analyzer</span>
        </span>
      </div>

      <div className="px-4">
        <button
          onClick={() => setView('submit')}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#2f6fe4] px-4 py-3 text-[14px] font-semibold text-white shadow-lg shadow-[#2f6fe4]/20 transition hover:bg-[#2560cc]"
        >
          <Upload size={17} strokeWidth={2.4} />
          New review
        </button>
      </div>

      <nav className="mt-7 flex-1 overflow-y-auto px-4 pb-4">
        <SectionLabel>Workspace</SectionLabel>
        {WORKSPACE.map((n) => (
          <NavItem
            key={n.id}
            {...n}
            active={isActive(n.id)}
            onClick={() => setView(n.id)}
            badge={n.id === 'reviews' ? badge : undefined}
          />
        ))}
        <div className="h-6" />
        <SectionLabel>Manage</SectionLabel>
        {MANAGE.map((n) => (
          <NavItem key={n.id} {...n} active={isActive(n.id)} onClick={() => setView(n.id)} />
        ))}
      </nav>

    </aside>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white/35">{children}</p>
}

function NavItem({
  label,
  icon: Icon,
  active,
  onClick,
  badge,
}: {
  label: string
  icon: typeof Home
  active: boolean
  onClick: () => void
  badge?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`relative mb-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] transition ${
        active ? 'bg-white/[0.08] font-semibold text-white' : 'text-white/60 hover:bg-white/5 hover:text-white/90'
      }`}
    >
      {active && <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r bg-[#4a8ae8]" />}
      <Icon size={18} strokeWidth={active ? 2.3 : 2} />
      <span className="flex-1 text-left">{label}</span>
      {!!badge && (
        <span className="rounded-full bg-white/15 px-1.5 text-[12px] font-semibold leading-[18px] text-white">{badge}</span>
      )}
    </button>
  )
}

export function Topbar({
  onMenu,
  user,
  setUser,
  query,
  setQuery,
  notifications,
  unread,
  onRead,
  onReadAll,
  onHelp,
  recent,
}: {
  onMenu: () => void
  user: UserId
  setUser: (u: UserId) => void
  query: string
  setQuery: (q: string) => void
  notifications: AppNotification[]
  unread: Set<string>
  onRead: (id: string) => void
  onReadAll: () => void
  onHelp: () => void
  recent: { id: string; title: string; sub: string }[]
}) {
  const [focused, setFocused] = useState(false)
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-md sm:gap-4 sm:px-8">
      <button
        onClick={onMenu}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden"
        aria-label="Open navigation"
      >
        <span className="space-y-[3px]">
          <span className="block h-[2px] w-4 bg-current" />
          <span className="block h-[2px] w-4 bg-current" />
          <span className="block h-[2px] w-4 bg-current" />
        </span>
      </button>

      <div className="relative flex min-w-0 flex-1 items-center">
        <Search size={18} className="pointer-events-none absolute left-0 text-slate-400" strokeWidth={2.2} />
        <input
          id="global-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder="Search contracts or counterparties"
          aria-label="Search contracts"
          className="w-full border-0 bg-transparent py-2 pl-7 pr-2 text-[14px] text-slate-700 outline-none placeholder:text-slate-400"
        />
        {/* G12 — recently viewed, shown when the empty search box is focused */}
        {focused && !query && recent.length > 0 && (
          <div className="animate-fade-in absolute left-0 top-full z-30 mt-2 w-[min(92vw,360px)] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl shadow-ink-900/10">
            <p className="px-4 pb-1 pt-2 text-[12px] font-medium text-ink-400">Recently viewed</p>
            {recent.map((r) => (
              <a key={r.id} href={`#/review/${r.id}`} className="flex items-center gap-3 px-4 py-2 hover:bg-slate-50">
                <Clock size={15} className="shrink-0 text-ink-300" />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium text-ink-900">{r.title}</span>
                  <span className="block truncate text-[12px] text-ink-500">{r.sub}</span>
                </span>
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <button
          onClick={onHelp}
          aria-label="What this assistant can do"
          title="What this assistant can do"
          className="grid h-9 w-9 place-items-center rounded-lg text-ink-500 hover:bg-slate-100 hover:text-ink-900"
        >
          <CircleHelp size={19} />
        </button>
        <NotificationsMenu items={notifications} unread={unread} onRead={onRead} onReadAll={onReadAll} />
        <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" />
        <label className="relative flex items-center gap-2 rounded-lg py-1 pl-1 pr-7 hover:bg-slate-50">
          <Avatar u={user} size={32} />
          <span className="hidden leading-tight sm:block">
            <span className="block text-[11px] text-slate-400">Viewing as</span>
            <span className="block text-[13px] font-semibold text-ink-900">{users[user].name}</span>
          </span>
          <ChevronDown size={15} className="pointer-events-none absolute right-1.5 text-slate-400" />
          <select
            aria-label="Switch user"
            value={user}
            onChange={(e) => setUser(e.target.value as UserId)}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            {userIds.map((u) => (
              <option key={u} value={u}>
                {users[u].name} - {users[u].title}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  )
}
