import { Lock } from 'lucide-react'
import { users, type UserId } from './data'
import { engineChangelog, notificationKindLabel, type NotificationKind, type Settings } from './hax'
import { Button, Card, PageHeader, Tag } from './ui'

/* ----------------------------- G17 — global controls ----------------------------- */

export function SettingsPage({
  settings,
  setSettings,
  user,
  onReset,
  analyzer,
}: {
  analyzer: 'claude' | 'rules' | 'offline'
  settings: Settings
  setSettings: (s: Settings) => void
  user: UserId
  onReset: () => void
}) {
  const isKD = users[user].superAdmin
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Control how the assistant shows its work. These preferences apply to you on this browser."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="What the review shows">
          <div className="divide-y divide-slate-100">
            <Toggle
              label="Show low-severity findings"
              hint="Off hides them behind a “Show” link. They are still examined and counted."
              on={settings.showLow}
              set={(v) => set('showLow', v)}
            />
            <Toggle
              label="Show suggested wording"
              hint="Draft negotiation language based on AtliQ precedent."
              on={settings.showWording}
              set={(v) => set('showWording', v)}
            />
            <Toggle
              label="Show AI confidence"
              hint="How sure the model was about each finding."
              on={settings.showConfidence}
              set={(v) => set('showConfidence', v)}
            />
          </div>
        </Card>

        <Card title="Notify me when">
          <div className="divide-y divide-slate-100">
            {(Object.keys(notificationKindLabel) as NotificationKind[]).map((k) => (
              <Toggle
                key={k}
                label={notificationKindLabel[k]}
                on={settings.notify[k]}
                set={(v) => set('notify', { ...settings.notify, [k]: v })}
              />
            ))}
          </div>
        </Card>

        <Card title="AI and data" subtitle={isKD ? undefined : 'Only Karandeep can change these.'}>
          <div className="divide-y divide-slate-100">
            <Fixed
              label="Analyzer"
              value={analyzer === 'claude' ? 'Claude Haiku 5.5' : analyzer === 'rules' ? 'Rules engine' : 'Offline'}
              note={
                analyzer === 'claude'
                  ? 'Claude plus deterministic rules; every quote is verified'
                  : analyzer === 'rules'
                    ? 'Free, offline clause checks. Set ANTHROPIC_API_KEY on the server to add Claude'
                    : 'Review server not reachable: sample data only'
              }
            />
            <Fixed label="Mask counterparty names before AI calls" value="On" note="Always on in this build" />
            <Fixed label="Clause coverage needed for a verdict" value="99%" note={isKD ? 'Set at calibration (PRD §17 #8)' : undefined} locked={!isKD} />
            <Fixed label="Learn from decisions" value="Approved only" note="Saved outcomes wait for KD's approval before they're used" locked={!isKD} />
            <Fixed label="Automatic signing" value="Never" note="Not available, by design" />
          </div>
        </Card>

        <Card title="Review engine" subtitle="Changes to models, prompts and rules">
          <ul className="space-y-4">
            {engineChangelog.map((e) => (
              <li key={e.version}>
                <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink-900">
                  {e.title}
                  <Tag className="bg-slate-100 font-mono text-ink-600">{e.version}</Tag>
                </p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-600">{e.detail}</p>
                <p className="mt-0.5 text-[12px] text-ink-400">
                  {e.date} · {e.affects}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Reset">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-xl text-[14px] text-ink-600">
            Clears what this browser remembers: recently viewed contracts, saved filters and read notifications.
            Contract decisions are not affected.
          </p>
          <Button onClick={onReset}>Reset remembered preferences</Button>
        </div>
      </Card>
    </div>
  )
}

function Toggle({ label, hint, on, set }: { label: string; hint?: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <span>
        <span className="block text-[14px] font-medium text-ink-900">{label}</span>
        {hint && <span className="block text-[13px] text-ink-500">{hint}</span>}
      </span>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden
        className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition peer-focus-visible:ring-4 peer-focus-visible:ring-brand-500/20 ${on ? 'bg-brand-600' : 'bg-slate-300'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
    </label>
  )
}

function Fixed({ label, value, note, locked }: { label: string; value: string; note?: string; locked?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <span>
        <span className="block text-[14px] font-medium text-ink-900">{label}</span>
        {note && <span className="block text-[13px] text-ink-500">{note}</span>}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-[14px] font-medium text-ink-700">
        {locked && <Lock size={13} className="text-ink-400" />}
        {value}
      </span>
    </div>
  )
}
