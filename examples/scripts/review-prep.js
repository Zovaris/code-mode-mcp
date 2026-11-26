// @description What changed on this branch: files by status, recent commits and TODOs added in changed files
// @param base string? git ref to compare with (default: merge-base with the default branch)

const [files, commits] = await Promise.all([changedFiles({ base: args.base }), recentCommits({ limit: 10 })]);
const code = files.filter((f) => f.status !== "D").map((f) => f.file);
const todos = (await Promise.all(code.map(async (file) => (await grep("\\bTODO\\b", { path: file })).map((h) => `${file}:${h.line}`)))).flat();
return { files, commits, todos };
