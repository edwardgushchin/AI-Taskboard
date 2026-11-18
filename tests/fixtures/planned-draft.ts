const lead = { lead: "qa-engineer", reason: "One specialist covers the fixture.", stages: [] };

export function plannedDraft<T extends object>(fields: T) {
  return {
    description: "Exercise the task workflow.",
    criteria: ["The fixture completes."],
    expertTeam: { work: lead, review: lead },
    ...fields,
  };
}
