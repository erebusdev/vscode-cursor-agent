import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import type { Question, QuestionAnswer, QuestionItem } from "../../../shared/protocol";
import { post } from "../../vscode";
import { Icon } from "../ui";

type Draft = { selected: string[]; text: string };

function AnsweredView({ item }: { item: QuestionItem }) {
  const byQ = new Map<string, QuestionAnswer>();
  for (const a of item.answers ?? []) byQ.set(a.questionId, a);
  return (
    <div class="question-answers">
      {item.questions.map((q) => {
        const a = byQ.get(q.id);
        const labels = (a?.selectedOptionIds ?? []).map((id) => q.options.find((o) => o.id === id)?.label ?? id);
        const parts = [...labels, ...(a?.text ? [a.text] : [])];
        return (
          <div key={q.id} class="question-answer">
            <div class="question-prompt muted">{q.prompt}</div>
            <div class="question-chosen">{parts.length ? parts.join(", ") : "—"}</div>
          </div>
        );
      })}
    </div>
  );
}

function QuestionBlock({ q, draft, onChange, disabled }: { q: Question; draft: Draft; onChange: (d: Draft) => void; disabled: boolean }) {
  const role = q.allowMultiple ? "checkbox" : "radio";
  const toggle = (id: string) => {
    if (q.allowMultiple) {
      onChange({ ...draft, selected: draft.selected.includes(id) ? draft.selected.filter((x) => x !== id) : [...draft.selected, id] });
    } else {
      onChange({ ...draft, selected: draft.selected.includes(id) ? [] : [id] });
    }
  };
  return (
    <div class="question" role="group" aria-label={q.prompt}>
      <div class="question-prompt">{q.prompt}</div>
      <div class="question-options" role={q.allowMultiple ? "group" : "radiogroup"}>
        {q.options.map((o) => {
          const checked = draft.selected.includes(o.id);
          return (
            <button title={o.label} key={o.id} type="button" role={role} aria-checked={checked} class={`option-button${checked ? " checked" : ""}`} disabled={disabled} onClick={() => toggle(o.id)}>
              <Icon name={checked ? (q.allowMultiple ? "pass-filled" : "circle-filled") : q.allowMultiple ? "circle-large-outline" : "circle-large-outline"} />
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
      <input
        type="text"
        class="text-input question-other"
        placeholder="Other…"
        value={draft.text}
        disabled={disabled}
        aria-label={`Other answer for: ${q.prompt}`}
        onInput={(e) => onChange({ ...draft, text: (e.currentTarget as HTMLInputElement).value })}
      />
    </div>
  );
}

export const QuestionCard = memo(function QuestionCard({ item }: { item: QuestionItem }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const pending = item.state === "pending";
  const get = (id: string): Draft => drafts[id] ?? { selected: [], text: "" };
  const canSubmit = pending && item.questions.every((q) => get(q.id).selected.length > 0 || get(q.id).text.trim().length > 0);

  const submit = () => {
    const answers: QuestionAnswer[] = item.questions.map((q) => {
      const d = get(q.id);
      return { questionId: q.id, selectedOptionIds: d.selected, text: d.text.trim() || undefined };
    });
    post({ type: "question.respond", requestId: item.requestId, answers });
  };

  return (
    <div class={`card question-card state-${item.state}`} data-item-id={item.id}>
      <div class="card-title">
        <Icon name="question" />
        <span>{item.title ?? "Question"}</span>
        {!pending && <span class="card-title-right muted">{item.state === "answered" ? "Answered" : item.state === "skipped" ? "Skipped" : "Cancelled"}</span>}
      </div>
      {pending ? (
        <>
          {item.questions.map((q) => (
            <QuestionBlock key={q.id} q={q} draft={get(q.id)} disabled={!pending} onChange={(d) => setDrafts({ ...drafts, [q.id]: d })} />
          ))}
          <div class="card-actions">
            <button title="Send your answer" type="button" class="button primary" disabled={!canSubmit} onClick={submit}>
              Submit
            </button>
            <button title="Skip this question" type="button" class="button secondary" onClick={() => post({ type: "question.skip", requestId: item.requestId })}>
              Skip
            </button>
          </div>
        </>
      ) : (
        <AnsweredView item={item} />
      )}
    </div>
  );
});
