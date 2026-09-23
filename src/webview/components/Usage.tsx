import { useEffect, useRef, useState } from "preact/hooks";
import type { UsageSummary, UsageWindow } from "../../shared/protocol";
import { pluralize, relativeTime } from "../format";
import { getState, setUsageOpen, useSelector } from "../store";
import { post } from "../vscode";
import { Popover } from "./Popover";
import { Icon, IconButton, Spinner, useNow } from "./ui";

const WARN_AT = 80;
const OVER_AT = 100;
const HEADER_DOT_AT = 90;
/** Re-fetch when the last result is older than this before showing it. */
const STALE_MS = 60_000;
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 250;
const DASHBOARD_URL = "https://cursor.com/dashboard?tab=usage";

function clampPct(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

/** "$20", "$1,118.88"; `compact` rounds to whole dollars for one-line summaries. */
function money(n: number, compact = false): string {
  const digits = compact || Number.isInteger(n) ? 0 : 2;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function levelClass(pct: number): string {
  return pct >= OVER_AT ? " over" : pct >= WARN_AT ? " warn" : "";
}

function maxUsed(summary: UsageSummary | undefined): number {
  if (!summary || summary.error) return 0;
  return Math.max(0, ...summary.windows.map((w) => w.usedPercent));
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

function longDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function refreshIfStale(): void {
  const usage = getState().usage;
  if (usage.loading) return;
  if (!usage.summary || Date.now() - usage.summary.checkedAt > STALE_MS) post({ type: "usage.refresh" });
}

function WindowBar({ w, detail }: { w: UsageWindow; detail?: string }) {
  const shown = Math.round(w.usedPercent);
  return (
    <div class={`usage-window${levelClass(w.usedPercent)}`}>
      <div class="usage-window-head">
        <span class="usage-window-label" title={w.label}>
          {w.label}
        </span>
        <span class="usage-window-pct">{shown}%</span>
      </div>
      <div class="usage-bar" role="progressbar" aria-label={w.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown}>
        <div class="usage-bar-fill" style={{ width: `${clampPct(w.usedPercent)}%` }} />
      </div>
      {detail && <div class="usage-window-detail">{detail}</div>}
    </div>
  );
}

function UsageError({ error }: { error: string }) {
  return (
    <div class="usage-error" role="alert">
      <Icon name="error" />
      <div>
        <div>{error}</div>
        <div class="usage-error-hint">
          If Cursor's config lives elsewhere, set <code>cursorAcp.configDir</code> in{" "}
          <button type="button" class="link-button" onClick={() => post({ type: "openSettings" })}>
            Settings
          </button>
          .
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header button + hover overview
// ---------------------------------------------------------------------------

/** One-line status for the compact overview: "Limit reached · Resets in 3d". */
function statusLine(summary: UsageSummary, now: number): string {
  const parts: string[] = [];
  const max = maxUsed(summary);
  if (max >= OVER_AT) parts.push("Limit reached");
  else if (max >= WARN_AT) parts.push("Near limit");
  if (summary.resetsAt) parts.push(`Resets ${resetsIn(summary.resetsAt, now)}`);
  return parts.join(" · ");
}

/** Compact spend: "$1,119 of $20 · +$1,099 bonus". */
function spendLine(summary: UsageSummary): string {
  if (summary.spendUsd === undefined || summary.limitUsd === undefined) return "";
  const base = `${money(summary.spendUsd, true)} of ${money(summary.limitUsd, true)}`;
  return summary.bonusUsd ? `${base} · +${money(summary.bonusUsd, true)} bonus` : base;
}

function accountLine(account: UsageSummary["account"]): string {
  if (!account) return "";
  return [account.email, account.team].filter((s): s is string => !!s).join(" · ");
}

function UsageOverview({ summary, now }: { summary: UsageSummary; now: number }) {
  const who = accountLine(summary.account);
  if (summary.error)
    return (
      <>
        {who && (
          <div class="usage-meta-line muted usage-account" title={who}>
            {who}
          </div>
        )}
        <UsageError error={summary.error} />
      </>
    );
  const status = statusLine(summary, now);
  const spend = spendLine(summary);
  return (
    <>
      {who && (
        <div class="usage-meta-line muted usage-account" title={who}>
          {who}
        </div>
      )}
      {summary.windows.length === 0 ? (
        <div class="usage-meta-line muted">No usage windows reported.</div>
      ) : (
        <div class="usage-windows">
          {summary.windows.map((w) => (
            <WindowBar key={w.id} w={w} />
          ))}
        </div>
      )}
      {(status || spend) && (
        <div class="usage-meta">
          {status && (
            <div class={`usage-meta-line${levelClass(maxUsed(summary))}`} title={summary.resetsAt ? `Resets ${new Date(summary.resetsAt).toLocaleString()}` : undefined}>
              {status}
            </div>
          )}
          {spend && (
            <div class="usage-meta-line" title={spend}>
              {spend}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Header pulse button. Hovering (or focusing) it shows a quick overview in a
 * popover that never takes focus; clicking opens the detailed usage pane.
 */
export function UsageButton() {
  const usage = useSelector((s) => s.usage);
  const paneOpen = useSelector((s) => s.usageOpen);
  const [hover, setHover] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const shown = hover && !paneOpen;
  const now = useNow(shown, 30_000);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHover(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown]);

  const schedule = (open: boolean, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (open) {
        if (getState().usageOpen) return;
        refreshIfStale();
      }
      setHover(open);
    }, delay);
  };
  const show = () => schedule(true, HOVER_OPEN_MS);
  const hide = () => schedule(false, HOVER_CLOSE_MS);
  const hold = () => window.clearTimeout(timer.current);
  const togglePane = () => {
    hold();
    setHover(false);
    setUsageOpen(!paneOpen);
  };

  const maxPct = maxUsed(usage.summary);
  const warn = maxPct >= HEADER_DOT_AT;

  return (
    <>
      <IconButton
        ref={anchor}
        icon="pulse"
        label={warn ? `Usage (${Math.round(maxPct)}% used)` : "Usage"}
        title={undefined}
        class={`usage-button${paneOpen ? " active" : ""}`}
        aria-pressed={paneOpen}
        onClick={togglePane}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {warn && <span class={`usage-warning-dot${maxPct >= OVER_AT ? " critical" : ""}`} aria-hidden="true" />}
      </IconButton>
      <Popover anchor={anchor} open={shown} onClose={() => setHover(false)} label="Usage overview" align="end" class="usage-popover" manageFocus={false}>
        <div class="usage-hover" onMouseEnter={hold} onMouseLeave={hide}>
          <div class="popover-heading">Usage</div>
          <div class="usage-body">
            {usage.loading && !usage.summary && (
              <div class="usage-loading">
                <Spinner /> Checking usage…
              </div>
            )}
            {!usage.loading && !usage.summary && <div class="usage-meta-line muted">No usage information yet.</div>}
            {usage.summary && <UsageOverview summary={usage.summary} now={now} />}
            <div class="usage-footer">
              <span class="usage-checked">{usage.loading && usage.summary ? <Spinner /> : usage.summary ? `Checked ${relativeTime(usage.summary.checkedAt, now)}` : ""}</span>
              <button type="button" class="link-button" onClick={togglePane}>
                Details
              </button>
            </div>
          </div>
        </div>
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detailed pane
// ---------------------------------------------------------------------------

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div class="kv-row" title={title}>
      <span class="kv-key">{label}</span>
      <span class="kv-val">{value}</span>
    </div>
  );
}

function windowDetail(w: UsageWindow, s: UsageSummary): string | undefined {
  switch (w.id) {
    case "totalPercentUsed":
      return s.message;
    case "autoPercentUsed":
      return s.autoMessage;
    case "apiPercentUsed":
      return s.namedMessage;
    default:
      return undefined;
  }
}

function UsageDetail({ s, now }: { s: UsageSummary; now: number }) {
  const hasSpend = s.spendUsd !== undefined || s.limitUsd !== undefined || s.bonusUsd !== undefined;
  const team = s.teamSpend;
  const teamLabel = team?.limitType ? `${team.limitType.charAt(0).toUpperCase()}${team.limitType.slice(1)} spend` : "Shared spend";
  return (
    <>
      {s.account && (s.account.email || s.account.team) && (
        <section class="pane-section" aria-labelledby="usage-account">
          <h3 id="usage-account" class="pane-heading">
            Account
          </h3>
          {s.account.email && <Row label="Signed in as" value={s.account.email} />}
          {s.account.team && <Row label="Team" value={s.account.teamRole ? `${s.account.team} (${s.account.teamRole})` : s.account.team} />}
        </section>
      )}
      <section class="pane-section" aria-labelledby="usage-plan">
        <h3 id="usage-plan" class="pane-heading">
          Plan usage
        </h3>
        {s.windows.length === 0 ? (
          <div class="usage-meta-line muted">No usage windows reported.</div>
        ) : (
          <div class="usage-windows detailed">
            {s.windows.map((w) => (
              <WindowBar key={w.id} w={w} detail={windowDetail(w, s)} />
            ))}
          </div>
        )}
      </section>

      {(s.cycleStartsAt || s.resetsAt) && (
        <section class="pane-section" aria-labelledby="usage-cycle">
          <h3 id="usage-cycle" class="pane-heading">
            Billing cycle
          </h3>
          {s.cycleStartsAt && <Row label="Started" value={longDate(s.cycleStartsAt)} />}
          {s.resetsAt && <Row label="Resets" value={`${longDate(s.resetsAt)} (${resetsIn(s.resetsAt, now)})`} title={new Date(s.resetsAt).toLocaleString()} />}
        </section>
      )}

      {hasSpend && (
        <section class="pane-section" aria-labelledby="usage-spend">
          <h3 id="usage-spend" class="pane-heading">
            Spend this cycle
          </h3>
          {s.limitUsd !== undefined && <Row label="Included in plan" value={s.includedSpendUsd !== undefined ? `${money(s.includedSpendUsd)} of ${money(s.limitUsd)}` : money(s.limitUsd)} />}
          {s.bonusUsd !== undefined && <Row label="Bonus usage" value={`${money(s.bonusUsd)}${s.bonusRemaining === false ? " (none left)" : ""}`} />}
          {s.spendUsd !== undefined && <Row label="Total" value={money(s.spendUsd)} />}
        </section>
      )}

      {team && (team.totalUsd !== undefined || team.individualUsd !== undefined) && (
        <section class="pane-section" aria-labelledby="usage-team">
          <h3 id="usage-team" class="pane-heading">
            {teamLabel}
          </h3>
          {team.totalUsd !== undefined && <Row label="Total" value={money(team.totalUsd)} />}
          {team.individualUsd !== undefined && <Row label="Your share" value={money(team.individualUsd)} />}
        </section>
      )}

      {s.autoModels && s.autoModels.length > 0 && (
        <section class="pane-section" aria-labelledby="usage-auto">
          <h3 id="usage-auto" class="pane-heading">
            Cursor models
          </h3>
          <details class="usage-models">
            <summary>{pluralize(s.autoModels.length, "model")} count as Cursor usage</summary>
            <ul class="usage-model-list">
              {s.autoModels.map((m) => (
                <li key={m}>
                  <code>{m}</code>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </>
  );
}

export function UsageView() {
  const usage = useSelector((s) => s.usage);
  const now = useNow(true, 30_000);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    refreshIfStale();
    backRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest(".popover")) return;
      e.preventDefault();
      setUsageOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const s = usage.summary;
  return (
    <div class="pane usage-view" role="region" aria-label="Usage">
      <div class="pane-top">
        <IconButton ref={backRef} icon="arrow-left" label="Back to chat" onClick={() => setUsageOpen(false)} />
        <h2 class="pane-title">Usage</h2>
        <span class="pane-top-actions">
          {usage.loading ? <Spinner class="section-spinner" /> : <IconButton icon="refresh" label="Refresh usage" onClick={() => post({ type: "usage.refresh" })} />}
        </span>
      </div>
      <div class="pane-scroll">
        {!s && usage.loading && (
          <div class="settings-loading">
            <Spinner /> Checking usage…
          </div>
        )}
        {!s && !usage.loading && (
          <div class="pane-empty">
            <span>No usage information yet.</span>
            <button type="button" class="link-button" onClick={() => post({ type: "usage.refresh" })}>
              Check now
            </button>
          </div>
        )}
        {s?.error && (
          <section class="pane-section">
            {s.account?.email && <Row label="Signed in as" value={s.account.email} />}
            <UsageError error={s.error} />
          </section>
        )}
        {s && !s.error && <UsageDetail s={s} now={now} />}
        {s && (
          <div class="pane-footer">
            <span class="usage-checked">Checked {relativeTime(s.checkedAt, now)}</span>
            <button type="button" class="link-button" onClick={() => post({ type: "openExternal", url: DASHBOARD_URL })}>
              Open Cursor dashboard <Icon name="link-external" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
