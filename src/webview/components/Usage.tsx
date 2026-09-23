import { useRef, useState } from "preact/hooks";
import type { UsageSummary, UsageWindow } from "../../shared/protocol";
import { relativeTime } from "../format";
import { useSelector } from "../store";
import { post } from "../vscode";
import { Popover } from "./Popover";
import { Icon, IconButton, Spinner, useNow } from "./ui";

const WARN_AT = 80;
const OVER_AT = 100;
const HEADER_DOT_AT = 90;

function clampPct(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function WindowBar({ w }: { w: UsageWindow }) {
  const pct = clampPct(w.usedPercent);
  const cls = w.usedPercent >= OVER_AT ? " over" : w.usedPercent >= WARN_AT ? " warn" : "";
  const shown = Math.round(w.usedPercent);
  return (
    <div class={`usage-window${cls}`}>
      <div class="usage-window-head">
        <span class="usage-window-label" title={w.label}>
          {w.label}
        </span>
        <span class="usage-window-pct">{shown}%</span>
      </div>
      <div class="usage-bar" role="progressbar" aria-label={w.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown}>
        <div class="usage-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function UsageDetails({ summary, now }: { summary: UsageSummary; now: number }) {
  const notes = [summary.message, summary.autoMessage, summary.namedMessage].filter((m): m is string => !!m && m.trim().length > 0);
  const hasSpend = summary.spendUsd !== undefined && summary.limitUsd !== undefined;
  return (
    <>
      {summary.error ? (
        <div class="usage-error" role="alert">
          <Icon name="error" />
          <div>
            <div>{summary.error}</div>
            <div class="usage-error-hint">
              If Cursor's config lives elsewhere, set <code>cursorAcp.configDir</code> in{" "}
              <button type="button" class="link-button" onClick={() => post({ type: "openSettings" })}>
                Settings
              </button>
              .
            </div>
          </div>
        </div>
      ) : summary.windows.length === 0 ? (
        <div class="usage-meta-line muted">No usage windows reported.</div>
      ) : (
        <div class="usage-windows">
          {summary.windows.map((w) => (
            <WindowBar key={w.id} w={w} />
          ))}
        </div>
      )}
      {(notes.length > 0 || summary.resetsAt || hasSpend) && (
        <div class="usage-meta">
          {notes.map((m, i) => (
            <div key={i} class="usage-meta-line">
              {m}
            </div>
          ))}
          {summary.resetsAt && (
            <div class="usage-meta-line" title={new Date(summary.resetsAt).toLocaleString()}>
              Resets {resetsIn(summary.resetsAt, now)}
            </div>
          )}
          {hasSpend && (
            <div class="usage-meta-line">
              Spend {money(summary.spendUsd as number)} of {money(summary.limitUsd as number)}
              {summary.bonusUsd ? ` (+${money(summary.bonusUsd)} bonus)` : ""}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** "in 3h" / "in 2d" for future timestamps; falls back to relativeTime for the past. */
function resetsIn(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = t - now;
  if (diff <= 0) return relativeTime(t, now);
  const min = Math.round(diff / 60_000);
  if (min < 60) return `in ${Math.max(1, min)}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

export function UsageButton() {
  const usage = useSelector((s) => s.usage);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const now = useNow(open, 30_000);

  const maxPct = usage.summary && !usage.summary.error ? Math.max(0, ...usage.summary.windows.map((w) => w.usedPercent)) : 0;
  const warn = maxPct >= HEADER_DOT_AT;

  const refresh = () => post({ type: "usage.refresh" });
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    refresh();
    setOpen(true);
  };

  return (
    <>
      <IconButton
        ref={anchor}
        icon="pulse"
        label={warn ? `Cursor usage (${Math.round(maxPct)}% used)` : "Cursor usage"}
        class="usage-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        {warn && <span class={`usage-warning-dot${maxPct >= OVER_AT ? " critical" : ""}`} aria-hidden="true" />}
      </IconButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Cursor usage" align="end" class="usage-popover">
        <div class="popover-heading">Cursor usage</div>
        <div class="usage-body">
          {usage.loading && !usage.summary && (
            <div class="usage-loading">
              <Spinner /> Checking usage…
            </div>
          )}
          {!usage.loading && !usage.summary && <div class="usage-meta-line muted">No usage information yet.</div>}
          {usage.summary && <UsageDetails summary={usage.summary} now={now} />}
          <div class="usage-footer">
            <span>{usage.loading && usage.summary ? <Spinner /> : usage.summary ? `Checked ${relativeTime(usage.summary.checkedAt, now)}` : ""}</span>
            <button type="button" class="link-button" onClick={refresh} disabled={usage.loading}>
              Refresh
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}
