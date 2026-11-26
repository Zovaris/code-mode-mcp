// Git helpers for the current repo. No config needed.
export const docs = {
  changedFiles: `changedFiles({base?: string}) -> [{status, file}] // files changed vs base (default: merge-base with origin's default branch), plus uncommitted`,
  recentCommits: `recentCommits({limit?: number, path?: string}) -> [{sha, author, date, subject}] // latest commits, optionally for one path`,
};

export default ({ sh }) => {
  const git = async (cmd) => (await sh(`git ${cmd}`, { check: true })).stdout.trim();
  const defaultBase = async () => {
    const head = await git("symbolic-ref --quiet --short refs/remotes/origin/HEAD").catch(() => "origin/main");
    return git(`merge-base HEAD ${head}`).catch(() => "HEAD");
  };
  return {
    async changedFiles({ base } = {}) {
      const from = base ?? (await defaultBase());
      const out = await git(`diff --name-status ${from}`);
      const untracked = await git("ls-files --others --exclude-standard");
      return [
        ...out.split("\n").filter(Boolean).map((l) => {
          const [status, ...rest] = l.split("\t");
          return { status, file: rest.at(-1) };
        }),
        ...untracked.split("\n").filter(Boolean).map((file) => ({ status: "?", file })),
      ];
    },
    async recentCommits({ limit = 20, path } = {}) {
      const out = await git(`log -n ${Number(limit)} --format=%h%x1f%an%x1f%as%x1f%s${path ? ` -- ${JSON.stringify(path)}` : ""}`);
      return out.split("\n").filter(Boolean).map((l) => {
        const [sha, author, date, subject] = l.split("\x1f");
        return { sha, author, date, subject };
      });
    },
  };
};
