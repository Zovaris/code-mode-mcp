// @description My issues in the given states with the PRs that mention each, plus my open PRs not linked to any of them
// @param states string[]? issue states (default config.issues.activeStates or Todo/In Progress)

const states = args.states ?? config.issues?.activeStates ?? ["Todo", "In Progress"];
const [issues, open] = await Promise.all([myIssues({ states }), myPRs({ state: "open" })]);
const linked = await Promise.all(issues.map(async (i) => ({
  id: i.id, title: i.title, status: i.status,
  prs: (await prsMentioning(i.id)).map((p) => `${p.repo}#${p.number} ${p.state}`),
})));
const ids = new Set(issues.map((i) => i.id.toLowerCase()));
const unlinked = open.filter((p) => ![...ids].some((id) => p.title.toLowerCase().includes(id)))
  .map((p) => `${p.repo}#${p.number} ${p.title}`);
return { issues: linked, unlinkedOpenPRs: unlinked };
