import { ArrowRight, ChevronRight, Upload, CheckCircle2 } from 'lucide-react'
import {
  approverOf,
  blockReasons,
  coverage,
  users,
  type Contract,
  delegationActive,
  type Delegation,
  type Obligation,
  type UserId,
} from './data'
import { Avatar, Button, EmptyState, StatePill, Tag } from './ui'
import { AS_OF_DATE, parseDay } from './hax'

export default function Overview({
  data,
  user,
  delegations,
  onOpen,
  onNew,
  onAll,
  onTeam,
  onRegister,
  obligations,
}: {
  obligations: Obligation[]
  data: Contract[]
  user: UserId
  delegations: Delegation[]
  onOpen: (id: string) => void
  onNew: () => void
  onAll: () => void
  onTeam: () => void
  onRegister: () => void
}) {
  const active = data.filter((c) => !['Signed', 'Rejected'].includes(c.status))
  const toDecide = active.filter((c) => approverOf(c, delegations).user === user)
  const toReview = active.filter((c) => c.primary === user || c.secondary === user)
  const blocked = active.filter((c) => blockReasons(c).length > 0)
  const attention = active.slice().sort((a, b) => blockReasons(b).length - blockReasons(a).length)
  const myDelegations = delegations.filter((d) => delegationActive(d) && (user === 'kd' || d.to === user))

  const hour = new Date().getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink-900">
            {greet}, {users[user].name}
          </h1>
          <p className="mt-1 text-[15px] text-ink-500">
            {toDecide.length
              ? `${toDecide.length} contract${toDecide.length > 1 ? 's are' : ' is'} waiting for your decision.`
              : toReview.length
                ? `${toReview.length} contract${toReview.length > 1 ? 's' : ''} assigned to you for review.`
                : 'Nothing is waiting on you right now.'}
          </p>
        </div>
        <Button variant="primary" size="lg" onClick={onNew}>
          <Upload size={17} strokeWidth={2.4} /> New review
        </Button>
      </div>

      <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,39,68,0.04)] sm:grid-cols-3 sm:divide-x sm:divide-slate-100">
        <Count label="Waiting for your decision" value={toDecide.length} onClick={onAll} />
        <Count label="Assigned to you as reviewer" value={toReview.length} onClick={onAll} />
        <Count label="Signing blocked" value={blocked.length} alert onClick={onAll} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section>
          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-[16px] font-semibold text-ink-900">Needs attention</h2>
            <button onClick={onAll} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:text-brand-700">
              All reviews <ArrowRight size={14} />
            </button>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,39,68,0.04)]">
            {attention.length === 0 ? (
              <EmptyState icon={<CheckCircle2 size={20} />} title="You're all caught up" action={<Button onClick={onNew}>Start a new review</Button>}>
                No open contracts are visible to you. New contracts appear here as soon as they are analysed.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100">
                {attention.map((c) => {
                  const reasons = blockReasons(c)
                  const cov = coverage(c)
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => onOpen(c.id)}
                        className="group flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-slate-50/80"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[15px] font-semibold text-ink-900">{c.counterparty}</span>
                            <span className="text-[13px] text-ink-400">{c.docType}</span>
                            {c.direction === 'outbound' && <Tag className="bg-brand-50 text-brand-700">Outbound draft</Tag>}
                          </span>
                          <span className={`mt-0.5 block truncate text-[13px] ${reasons.length ? 'text-ink-700' : 'text-ink-500'}`}>
                            {reasons.length ? reasons[0] : 'Ready for a decision'}
                            {reasons.length > 1 && <span className="text-ink-400"> · +{reasons.length - 1} more</span>}
                          </span>
                        </span>
                        <span className="hidden shrink-0 sm:block">
                          <StatePill s={cov.below ? 'insufficient-evidence' : c.state} />
                        </span>
                        <span className="hidden shrink-0 -space-x-1 md:flex">
                          <Avatar u={c.primary} size={26} ring />
                          {c.secondary && <Avatar u={c.secondary} size={26} ring />}
                        </span>
                        <ChevronRight size={18} className="shrink-0 text-ink-300 transition group-hover:translate-x-0.5 group-hover:text-ink-700" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>

        <div className="space-y-5 xl:pt-9">
          <DelegationsCard delegations={myDelegations} canDelegate={user === 'kd'} onTeam={onTeam} />

          <LiftingSoon onRegister={onRegister} obligations={obligations} />
        </div>
      </div>
    </div>
  )
}

function Count({ label, value, alert, onClick }: { label: string; value: number; alert?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group border-b border-slate-100 px-6 py-5 text-left transition last:border-b-0 hover:bg-slate-50/80 sm:border-b-0">
      <p className="text-[13px] text-ink-500">{label}</p>
      <p className={`mt-1 text-[32px] font-bold leading-none tracking-[-0.02em] tabular-nums ${alert && value ? 'text-risk-high' : 'text-ink-900'}`}>
        {value}
      </p>
    </button>
  )
}

/* ---------------- Restrictions lifting soon ---------------- */

const DAY = 86_400_000
const TODAY = AS_OF_DATE // the dataset's "today" (28 Sep 2026)
const parseDate = parseDay

function timeLeft(days: number) {
  if (days < 1) return 'Lifts today'
  if (days < 45) return `${days} days left`
  const months = Math.round(days / 30.4)
  if (months < 18) return `${months} months left`
  return `${(days / 365).toFixed(1)} years left`
}

function LiftingSoon({ onRegister, obligations }: { onRegister: () => void; obligations: Obligation[] }) {
  const live = obligations.filter((o) => o.status === 'active')
  const dated = live
    .filter((o) => !Number.isNaN(parseDate(o.expires).getTime()))
    .map((o) => {
      const start = parseDate(o.effective).getTime()
      const end = parseDate(o.expires).getTime()
      const days = Math.ceil((end - TODAY.getTime()) / DAY)
      const elapsed = Math.min(1, Math.max(0, (TODAY.getTime() - start) / (end - start)))
      return { o, days, elapsed }
    })
    .sort((a, b) => a.days - b.days)
  const shown = dated.slice(0, 4)
  const ongoing = live.length - dated.length

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,39,68,0.04)]">
      <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div>
          <h2 className="text-[14px] font-semibold text-ink-900">Restrictions lifting soon</h2>
          <p className="mt-0.5 text-[12px] text-ink-500">Live promises, soonest to end first</p>
        </div>
      </header>

      {shown.length === 0 ? (
        <p className="px-5 pb-5 text-[13px] text-ink-500">No dated restrictions are in force.</p>
      ) : (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {shown.map(({ o, days, elapsed }) => {
            const soon = days <= 120
            return (
              <li key={o.id}>
                <button
                  onClick={onRegister}
                  title={`${o.summary} (${o.sourceContract})`}
                  className="group block w-full px-5 py-3.5 text-left transition hover:bg-slate-50/80"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-[14px] font-semibold text-ink-900">{o.clauseType}</span>
                    <span className={`shrink-0 text-[13px] font-medium tabular-nums ${soon ? 'text-risk-med' : 'text-ink-700'}`}>
                      {timeLeft(days)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-baseline justify-between gap-3 text-[12px] text-ink-500">
                    <span className="min-w-0 truncate">{o.counterparty}</span>
                    <span className="shrink-0 tabular-nums text-ink-400">{o.expires}</span>
                  </span>
                  {/* How much of the restriction's term has already run */}
                  <span className="mt-2.5 block h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                    <span
                      className={`block h-full rounded-full ${soon ? 'bg-risk-med' : 'bg-ink-300'}`}
                      style={{ width: `${elapsed * 100}%` }}
                    />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <button
        onClick={onRegister}
        className="flex w-full items-center justify-between border-t border-slate-100 px-5 py-3 text-[13px] font-medium text-brand-600 transition hover:bg-slate-50/80 hover:text-brand-700"
      >
        <span>
          All {live.length} live obligations
          {ongoing > 0 && <span className="font-normal text-ink-400"> · {ongoing} with no end date</span>}
        </span>
        <ArrowRight size={14} />
      </button>
    </section>
  )
}

/* ---------------- Delegations ---------------- */

function DelegationsCard({
  delegations,
  canDelegate,
  onTeam,
}: {
  delegations: Delegation[]
  canDelegate: boolean
  onTeam: () => void
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,39,68,0.04)]">
      <header className="px-5 pb-3 pt-4">
        <h2 className="text-[14px] font-semibold text-ink-900">Delegations</h2>
        <p className="mt-0.5 text-[12px] text-ink-500">Approval covered while KD is away</p>
      </header>

      {delegations.length ? (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {delegations.map((d) => {
            const days = Math.ceil((parseDate(d.expires).getTime() - TODAY.getTime()) / DAY)
            return (
              <li key={d.id}>
                <button onClick={onTeam} className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition hover:bg-slate-50/80">
                  <Avatar u={d.to} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[14px] font-semibold text-ink-900">{users[d.to].name}</span>
                      <span className={`shrink-0 text-[13px] font-medium tabular-nums ${days <= 3 ? 'text-risk-med' : 'text-ink-700'}`}>
                        {days < 1 ? 'Ends today' : `${days} day${days > 1 ? 's' : ''} left`}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-baseline justify-between gap-3 text-[12px] text-ink-500">
                      <span className="truncate">
                        Approves {d.scope === 'all-routine' ? 'routine contracts' : d.scope.join(', ')}
                      </span>
                      <span className="shrink-0 tabular-nums text-ink-400">{d.expires}</span>
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="border-t border-slate-100 px-5 py-4 text-[13px] leading-relaxed text-ink-500">
          No one is covering. Every approval waits for KD.
        </p>
      )}

      <button
        onClick={onTeam}
        className="flex w-full items-center justify-between border-t border-slate-100 px-5 py-3 text-[13px] font-medium text-brand-600 transition hover:bg-slate-50/80 hover:text-brand-700"
      >
        <span>
          {canDelegate ? (delegations.length ? 'Manage delegations' : 'Delegate approval') : 'View team & access'}
          <span className="font-normal text-ink-400"> · signing stays with KD</span>
        </span>
        <ArrowRight size={14} />
      </button>
    </section>
  )
}
