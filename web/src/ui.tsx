import type { ReactNode } from 'react'
import type { Severity, ReviewState, UserId, ObligationStatus } from './data'
import { severityLabel, stateLabel, users } from './data'
import { confidenceWord } from './hax'

/*
 * Type scale (px): 12 meta · 13 secondary · 14 body · 16 card title · 20 section · 28 page.
 * Weights: 400 body, 500 labels, 600 titles, 700 page headings only.
 */

const SEV: Record<Severity, { pill: string; dot: string }> = {
  high: { pill: 'bg-risk-high-bg text-risk-high', dot: 'bg-risk-high' },
  medium: { pill: 'bg-risk-med-bg text-risk-med', dot: 'bg-risk-med' },
  low: { pill: 'bg-risk-low-bg text-risk-low', dot: 'bg-risk-low' },
  unknown: { pill: 'bg-risk-unk-bg text-risk-unk', dot: 'bg-risk-unk' },
}

export const sevDot = (s: Severity) => SEV[s].dot

export function SeverityPill({ s }: { s: Severity }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-semibold ${SEV[s].pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${SEV[s].dot}`} />
      {severityLabel[s]}
    </span>
  )
}

const STATE_SEV: Record<ReviewState, Severity> = {
  green: 'low',
  amber: 'medium',
  red: 'high',
  'insufficient-evidence': 'unknown',
  'conflicting-evidence': 'unknown',
}

export function StatePill({ s }: { s: ReviewState }) {
  const k = STATE_SEV[s]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-semibold ${SEV[k].pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${SEV[k].dot}`} />
      {stateLabel[s]}
    </span>
  )
}

export const stateTone = (s: ReviewState) => STATE_SEV[s]

/** Live is neutral-strong (in force), not red — red is reserved for things that block signing. */
export function ObligationPill({ s }: { s: ObligationStatus }) {
  const map: Record<ObligationStatus, [string, string, string]> = {
    active: ['Live', 'bg-ink-900/[0.06] text-ink-900', 'bg-ink-900'],
    expired: ['Expired', 'bg-slate-100 text-ink-400', 'bg-ink-300'],
    superseded: ['Superseded', 'bg-slate-100 text-ink-400', 'bg-ink-300'],
  }
  const [label, cls, dot] = map[s]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

export function LabelPill({ l }: { l: 'standard' | 'exception' | 'unknown' }) {
  const cls =
    l === 'standard'
      ? 'bg-risk-low-bg text-risk-low'
      : l === 'exception'
        ? 'bg-risk-med-bg text-risk-med'
        : 'bg-slate-100 text-ink-500'
  const text = l === 'standard' ? 'Standard position' : l === 'exception' ? 'One-off exception' : 'Unlabelled'
  return <Tag className={cls}>{text}</Tag>
}

export function Tag({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium ${className}`}>
      {children}
    </span>
  )
}

export function Avatar({ u, size = 28, ring }: { u: UserId; size?: number; ring?: boolean }) {
  const tones: Record<UserId, string> = {
    kd: 'bg-ink-900 text-white',
    bhavin: 'bg-[#dbe7fb] text-[#1f56b8]',
    dhaval: 'bg-[#d9f0e3] text-[#157347]',
    jay: 'bg-[#fbecd0] text-[#8a4e05]',
  }
  return (
    <span
      title={users[u].name}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${tones[u]} ${ring ? 'ring-2 ring-white' : ''}`}
    >
      {users[u].initials}
    </span>
  )
}

export function Card({
  title,
  subtitle,
  right,
  children,
  id,
  flush,
  className = '',
}: {
  title?: ReactNode
  subtitle?: string
  right?: ReactNode
  children: ReactNode
  id?: string
  flush?: boolean
  className?: string
}) {
  return (
    <section
      id={id}
      className={`scroll-mt-32 rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,39,68,0.04)] ${className}`}
    >
      {title && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-ink-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-500">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      <div className={flush ? 'pt-3' : 'px-5 pb-5 pt-4 sm:px-6'}>{children}</div>
    </section>
  )
}

/** Quoted source text — FR-10. Roman, not italic: these are read closely. */
export function Evidence({
  quote,
  page,
  section,
  label = 'This contract',
  tone = 'neutral',
}: {
  quote: string
  page?: number
  section?: string
  label?: string
  tone?: 'neutral' | 'danger' | 'muted'
}) {
  const border = tone === 'danger' ? 'border-risk-high' : tone === 'muted' ? 'border-ink-300' : 'border-ink-700'
  return (
    <figure className={`border-l-2 ${border} py-0.5 pl-4`}>
      <blockquote className={`text-[14px] leading-[1.65] ${tone === 'muted' ? 'text-ink-500' : 'text-ink-800'}`}>
        “{quote}”
      </blockquote>
      <figcaption className="mt-1.5 text-[12px] text-ink-400">
        {label}
        {section && <> · clause {section}</>}
        {page !== undefined && <> · p. {page}</>}
      </figcaption>
    </figure>
  )
}

export function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const tone = pct >= 85 ? 'bg-ink-700' : pct >= 60 ? 'bg-risk-med' : 'bg-risk-high'
  return (
    <span className="inline-flex items-center gap-2" title={`Model confidence ${pct}%`}>
      <span className="h-1 w-12 overflow-hidden rounded-full bg-slate-200">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[12px] tabular-nums text-ink-500">
        {confidenceWord(value)} · {pct}%
      </span>
    </span>
  )
}

export function Banner({
  tone,
  title,
  children,
  icon,
  action,
}: {
  tone: 'danger' | 'warn' | 'info' | 'ok'
  title: string
  children?: ReactNode
  icon?: ReactNode
  action?: ReactNode
}) {
  const map = {
    danger: 'border-risk-high/20 bg-risk-high-bg [&_.bn-t]:text-risk-high',
    warn: 'border-risk-med/20 bg-risk-med-bg [&_.bn-t]:text-risk-med',
    info: 'border-brand-500/20 bg-brand-50 [&_.bn-t]:text-brand-700',
    ok: 'border-risk-low/20 bg-risk-low-bg [&_.bn-t]:text-risk-low',
  }
  return (
    <div className={`flex gap-3 rounded-lg border px-4 py-3 ${map[tone]}`}>
      {icon && <span className="bn-t mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        <p className="bn-t text-[14px] font-semibold">{title}</p>
        {children && <div className="mt-0.5 text-[13px] leading-relaxed text-ink-700">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

export function Field({ label, value, bad }: { label: string; value: ReactNode; bad?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-500">{label}</dt>
      <dd className={`mt-0.5 text-[14px] ${bad ? 'font-semibold text-risk-high' : 'font-medium text-ink-900'}`}>{value}</dd>
    </div>
  )
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  title,
  type = 'button',
  className = '',
  size = 'md',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'ghost'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
  className?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const v = {
    primary: 'bg-brand-600 text-white shadow-sm shadow-brand-600/20 hover:bg-brand-700',
    success: 'bg-risk-low text-white shadow-sm hover:brightness-110',
    danger: 'text-risk-high hover:bg-risk-high-bg',
    secondary: 'bg-white text-ink-800 border border-slate-300 shadow-[0_1px_1px_rgba(15,39,68,0.04)] hover:bg-slate-50',
    ghost: 'text-ink-600 hover:bg-slate-100 hover:text-ink-900',
  }[variant]
  const s = { sm: 'h-8 px-2.5 text-[13px]', md: 'h-9 px-3.5 text-[14px]', lg: 'h-11 px-5 text-[15px]' }[size]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${s} ${v} ${className}`}
    >
      {children}
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; count?: number }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-slate-200/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition ${
            value === o.value ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900'
          }`}
        >
          {o.label}
          {o.count !== undefined && (
            <span className={`ml-1.5 tabular-nums ${value === o.value ? 'text-ink-500' : 'text-ink-400'}`}>{o.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export const inputCls =
  'h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-[14px] text-ink-900 shadow-[0_1px_1px_rgba(15,39,68,0.03)] outline-none transition placeholder:text-ink-300 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10'

export function LabelledInput({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink-800">
        {label}
        {hint && <span className="ml-1 font-normal text-ink-400">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink-900">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-[14px] text-ink-500">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-slate-100 text-ink-400">{icon}</span>
      <p className="mt-3 text-[15px] font-semibold text-ink-900">{title}</p>
      {children && <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-ink-500">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
