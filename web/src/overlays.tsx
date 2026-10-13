import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X, Check, Minus, Bell, Keyboard } from 'lucide-react'
import { Button } from './ui'
import type { AppNotification } from './hax'

/* ----------------------------- Modal base ----------------------------- */

function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Keep the latest onClose without re-running the focus effect on every parent render.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
      // Keep focus inside the dialog.
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea')
        if (!f.length) return
        const first = f[0]
        const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          last.focus()
          e.preventDefault()
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus()
          e.preventDefault()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div ref={ref} tabIndex={-1} className={`animate-fade-in relative w-full ${width} rounded-2xl bg-white shadow-2xl shadow-ink-900/20 outline-none`}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2 className="text-[18px] font-semibold text-ink-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="-mr-2 grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-slate-100 hover:text-ink-900">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 pb-5 pt-3">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 rounded-b-2xl border-t border-slate-100 bg-slate-50/70 px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}

/* ----------------------------- G16 — consequences ----------------------------- */

export interface ConfirmRequest {
  title: string
  intro?: string
  consequences: string[]
  confirmLabel: string
  tone?: 'primary' | 'danger' | 'success'
  onConfirm: () => void
}

export function ConfirmDialog({ req, onClose }: { req: ConfirmRequest | null; onClose: () => void }) {
  return (
    <Modal
      open={!!req}
      onClose={onClose}
      title={req?.title ?? ''}
      footer={
        req && (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={req.tone === 'danger' ? 'secondary' : req.tone === 'success' ? 'success' : 'primary'}
              className={req.tone === 'danger' ? '!border-risk-high !bg-risk-high !text-white hover:!brightness-110' : ''}
              onClick={() => {
                req.onConfirm()
                onClose()
              }}
            >
              {req.confirmLabel}
            </Button>
          </>
        )
      }
    >
      {req?.intro && <p className="mb-3 text-[14px] leading-relaxed text-ink-700">{req.intro}</p>}
      <p className="text-[13px] font-semibold text-ink-900">What happens next</p>
      <ul className="mt-2 space-y-2">
        {req?.consequences.map((c) => (
          <li key={c} className="flex gap-2.5 text-[14px] leading-snug text-ink-700">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-400" />
            {c}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/* ----------------------------- G8 — toasts with undo ----------------------------- */

export interface ToastItem {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

export function Toasts({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex w-[min(92vw,440px)] -translate-x-1/2 flex-col gap-2 lg:left-[calc(50%+130px)]" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="animate-fade-in pointer-events-auto flex items-center gap-3 rounded-xl bg-ink-900 px-4 py-3 text-[14px] text-white shadow-xl shadow-ink-900/25">
          <span className="min-w-0 flex-1">{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
              className="shrink-0 rounded-md px-2 py-1 font-semibold text-[#8fb6f7] hover:bg-white/10"
            >
              {t.action.label}
            </button>
          )}
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="shrink-0 text-white/50 hover:text-white">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}

/* ----------------------------- G1 — what it can do ----------------------------- */

export const CAN = [
  'Read every clause and show which ones it examined',
  'Quote the exact text behind each finding',
  'Check the AtliQ legal entity and governing law',
  'Find conflicts with promises AtliQ has already signed',
  'Show how AtliQ handled similar clauses before',
  'Suggest wording to negotiate with, as a draft',
]

export const CANNOT = [
  'Sign, approve or send anything',
  'See promises made on calls, WhatsApp, Teams or Slack',
  'Give legal advice: it flags risk for people to judge',
  'Review non-English contracts or files over 100 pages',
  'Review employee or freelancer contracts',
]

export function Capabilities({ compact }: { compact?: boolean }) {
  return (
    <div className={`grid gap-5 ${compact ? 'sm:grid-cols-2' : 'md:grid-cols-2'}`}>
      <div>
        <p className="text-[13px] font-semibold text-ink-900">What it does</p>
        <ul className="mt-2 space-y-1.5">
          {CAN.map((c) => (
            <li key={c} className="flex gap-2 text-[13px] leading-snug text-ink-700">
              <Check size={15} className="mt-px shrink-0 text-risk-low" strokeWidth={2.5} />
              {c}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="text-[13px] font-semibold text-ink-900">What it doesn't do</p>
        <ul className="mt-2 space-y-1.5">
          {CANNOT.map((c) => (
            <li key={c} className="flex gap-2 text-[13px] leading-snug text-ink-700">
              <Minus size={15} className="mt-px shrink-0 text-ink-400" strokeWidth={2.5} />
              {c}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function AboutDialog({ open, onClose, onShortcuts }: { open: boolean; onClose: () => void; onShortcuts: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="About the review assistant"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onShortcuts}>
            <Keyboard size={15} /> Keyboard shortcuts
          </Button>
          <Button variant="primary" onClick={onClose}>
            Got it
          </Button>
        </>
      }
    >
      <p className="text-[14px] leading-relaxed text-ink-700">
        The assistant reads a contract, flags risk and explains why. <strong className="text-ink-900">People decide</strong>;
        it never signs, approves or sends anything.
      </p>
      <div className="mt-5">
        <Capabilities />
      </div>
    </Modal>
  )
}

/* ----------------------------- G7 — shortcuts ----------------------------- */

const SHORTCUTS: [string, string][] = [
  ['N', 'Start a new review'],
  ['/', 'Search contracts'],
  ['J / K', 'Next / previous finding'],
  ['?', 'Show this list'],
  ['Esc', 'Close a dialog or menu'],
]

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width="max-w-sm">
      <ul className="divide-y divide-slate-100">
        {SHORTCUTS.map(([k, l]) => (
          <li key={k} className="flex items-center justify-between py-2.5 text-[14px] text-ink-700">
            {l}
            <kbd className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[12px] text-ink-700">{k}</kbd>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/* ----------------------------- popover (click-away) ----------------------------- */

export function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref }
}

/* ----------------------------- G3 / G18 — notifications ----------------------------- */

export function NotificationsMenu({
  items,
  unread,
  onRead,
  onReadAll,
}: {
  items: AppNotification[]
  unread: Set<string>
  onRead: (id: string) => void
  onReadAll: () => void
}) {
  const p = usePopover()
  const count = items.filter((n) => unread.has(n.id)).length
  return (
    <div ref={p.ref} className="relative">
      <button
        onClick={() => p.setOpen((v) => !v)}
        aria-label={`Notifications${count ? `, ${count} unread` : ''}`}
        aria-expanded={p.open}
        className="relative grid h-9 w-9 place-items-center rounded-lg text-ink-500 hover:bg-slate-100 hover:text-ink-900"
      >
        <Bell size={19} />
        {count > 0 && (
          <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-risk-high px-1 text-[10px] font-bold text-white">
            {count}
          </span>
        )}
      </button>
      {p.open && (
        <div className="animate-fade-in absolute right-0 z-30 mt-2 w-[min(92vw,380px)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl shadow-ink-900/10">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-[14px] font-semibold text-ink-900">Notifications</p>
            {count > 0 && (
              <button onClick={onReadAll} className="text-[13px] font-medium text-brand-600 hover:text-brand-700">
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-ink-500">You're all caught up.</p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <a
                    href={n.to ?? '#'}
                    onClick={() => {
                      onRead(n.id)
                      p.setOpen(false)
                    }}
                    className="flex gap-3 px-4 py-3 hover:bg-slate-50"
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread.has(n.id) ? 'bg-brand-600' : 'bg-transparent'}`} />
                    <span className="min-w-0">
                      <span className={`block text-[13px] leading-snug ${unread.has(n.id) ? 'font-semibold text-ink-900' : 'text-ink-700'}`}>{n.title}</span>
                      <span className="block text-[12px] text-ink-500">{n.detail}</span>
                      <span className="block text-[12px] text-ink-400">{n.at}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <a href="#/settings" onClick={() => p.setOpen(false)} className="block border-t border-slate-100 px-4 py-2.5 text-[13px] font-medium text-ink-500 hover:bg-slate-50 hover:text-ink-900">
            Choose what you're notified about
          </a>
        </div>
      )}
    </div>
  )
}
