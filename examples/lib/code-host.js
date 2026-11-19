// Code host adapter (GitHub MCP). Swap this file to change host; the function names stay.
// config.codeHost: { "server": "github", "org": "my-org" }
const slim = (p, org) => ({
  repo: (p.repository_url?.split("/repos/")[1] ?? "").replace(org ? `${org}/` : "", ""),
  number: p.number,
  title: p.title,
  state: p.pull_request?.merged_at ? "merged" : p.state,
  draft: !!p.draft,
  url: p.html_url,
  updated: p.updated_at?.slice(0, 10),
});

export const docs = {
  myPRs: `myPRs({state?: "open"|"closed"|"all", limit?: number}) -> [{repo, number, title, state, draft, url, updated}] // my PRs (org from config.codeHost)`,
  prsMentioning: `prsMentioning(text: string) -> [{repo, number, title, state, draft, url, updated}] // PRs whose title/body mention text, e.g. an issue id`,
};

export default ({ mcp, config }) => {
  const cfg = { server: "github", ...(config.codeHost ?? {}) };
  const scope = cfg.org ? ` org:${cfg.org}` : "";
  const search = async (query, perPage) =>
    ((await mcp.call(cfg.server, "search_pull_requests", { query, perPage })).items ?? []).map((p) => slim(p, cfg.org));
  return {
    myPRs: ({ state = "open", limit = 50 } = {}) =>
      search(`author:@me${scope}${state === "all" ? "" : ` is:${state}`}`, Math.min(limit, 100)),
    prsMentioning: (text) => search(`${text}${scope}`, 30),
  };
};
