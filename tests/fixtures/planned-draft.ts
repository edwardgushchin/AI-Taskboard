import { locateBoard, onBoard } from "../../src/cli/storage.ts";

export function confirmFixtureDraft(project: string, id: string): void {
  onBoard(locateBoard(project), store => {
    const task = store.card(id);
    if (task.status === "draft" && task.awaitingAnswer === undefined) {
      store.save({ ...task, awaitingAnswer: false, draftDiscussion: undefined });
    }
  });
}

const lead = { lead: "qa-engineer", reason: "One specialist covers the fixture.", stages: [] };

export function plannedDraft<T extends object>(fields: T) {
  return {
    description: "Exercise the task workflow.",
    criteria: ["The fixture completes."],
    expertTeam: { work: lead, review: lead },
    ...fields,
  };
}
