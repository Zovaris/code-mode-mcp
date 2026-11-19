// Abaco helpers for code-mode run_script. Globals inside scripts.
const ORG = "Abaco-Tech";
const TEAM = "Debt Servicing";

const repoOf = (url = "") => url.split("/repos/")[1] ?? url;
const slimPR = (p) => ({
  repo: repoOf(p.repository_url).replace(`${ORG}/`, ""),
  number: p.number,
  title: p.title,
  state: p.pull_request?.merged_at ? "merged" : p.state,
  draft: !!p.draft,
  url: p.html_url,
  updated: p.updated_at?.slice(0, 10),
});

export const docs = {
  myIssues: `myIssues({states?: string[], team?: string, limit?: number}) -> [{id, title, status, priority, url, branch, updated}] // my Linear issues (default team ${TEAM}, all states)`,
  myPRs: `myPRs({state?: "open"|"closed"|"all", limit?: number}) -> [{repo, number, title, state, draft, url, updated}] // my GitHub PRs in ${ORG}`,
  prsForIssue: `prsForIssue(id: string) -> [{repo, number, title, state, draft, url, updated}] // PRs in ${ORG} that mention a Linear id like "COL-180"`,
};

export default ({ mcp }) => ({
  async myIssues({ states, team = TEAM, limit = 100 } = {}) {
    const run = (state) => mcp.linear.list_issues({ assignee: "me", team, state, limit });
    const pages = states?.length ? await Promise.all(states.map(run)) : [await run(undefined)];
    return pages
      .flatMap((r) => r.issues ?? [])
      .map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        priority: i.priority?.name,
        url: i.url,
        branch: i.gitBranchName,
        updated: i.updatedAt?.slice(0, 10),
      }));
  },

  async myPRs({ state = "open", limit = 50 } = {}) {
    const q = `author:@me org:${ORG}` + (state === "all" ? "" : ` is:${state}`);
    const r = await mcp.github.search_pull_requests({ query: q, perPage: Math.min(limit, 100) });
    return (r.items ?? []).map(slimPR);
  },

  async prsForIssue(id) {
    const r = await mcp.github.search_pull_requests({ query: `${id} org:${ORG}`, perPage: 30 });
    return (r.items ?? []).map(slimPR);
  },
});
