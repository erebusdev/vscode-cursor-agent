import { memo } from "preact/compat";
import type { PlanProposalItem } from "../../../shared/protocol";
import { post } from "../../vscode";
import { Markdown } from "../Markdown";
import { Icon } from "../ui";
import { TaskList } from "./PlanCard";

const STATE_LABEL: Record<PlanProposalItem["state"], string> = {
  pending: "",
  accepted: "Accepted",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const PlanProposalCard = memo(function PlanProposalCard({ item }: { item: PlanProposalItem }) {
  const pending = item.state === "pending";
  return (
    <div class={`card plan-proposal state-${item.state}`} data-item-id={item.id}>
      <div class="card-title">
        <Icon name="map" />
        <span>{item.name ?? "Plan"}</span>
        {!pending && (
          <span class={`card-title-right state-label ${item.state}`}>
            <Icon name={item.state === "accepted" ? "check" : item.state === "rejected" ? "close" : "circle-slash"} /> {STATE_LABEL[item.state]}
          </span>
        )}
      </div>
      {item.overview && <div class="plan-overview">{item.overview}</div>}
      {item.plan && <Markdown text={item.plan} class="plan-markdown" />}
      {item.todos.length > 0 && (
        <div class="plan-todos">
          <div class="section-label">Todos</div>
          <TaskList entries={item.todos.map((t) => ({ content: t.content, status: t.status, key: t.id }))} />
        </div>
      )}
      {pending && (
        <div class="card-actions">
          <button type="button" class="button primary" data-autofocus onClick={() => post({ type: "plan.respond", requestId: item.requestId, accepted: true })}>
            Accept
          </button>
          <button type="button" class="button secondary" onClick={() => post({ type: "plan.respond", requestId: item.requestId, accepted: false })}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
});
