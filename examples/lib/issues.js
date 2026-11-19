// Issue tracker adapter (Linear MCP). Swap this file to change tracker; the function names stay.
// config.issues: { "server": "linear", "team": "My Team", "assignee": "me" }
export const docs = {
  myIssues: `myIssues({states?: string[], team?: string, limit?: number}) -> [{id, title, status, priority, url, branch, updated}] // my issues (team from config.issues)`,
};

export default ({ mcp, config }) => {
  const cfg = { server: "linear", assignee: "me", ...(config.issues ?? {}) };
  return {
    async myIssues({ states, team = cfg.team, limit = 100 } = {}) {
      const call = (state) => mcp.call(cfg.server, "list_issues", { assignee: cfg.assignee, team, state, limit });
      const pages = states?.length ? await Promise.all(states.map(call)) : [await call(undefined)];
      return pages
        .flatMap((r) => r.issues ?? [])
        .map((i) => ({
          id: i.id, title: i.title, status: i.status, priority: i.priority?.name,
          url: i.url, branch: i.gitBranchName, updated: i.updatedAt?.slice(0, 10),
        }));
    },
  };
};
