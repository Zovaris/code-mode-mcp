// @description TODO/FIXME/HACK comments grouped by file, most first
// @param path string? folder to scan (default: cwd)
// @param limit number? max files to return (default 20)

const hits = await grep("\\b(TODO|FIXME|HACK)\\b", { path: args.path, limit: 5000 });
const byFile = {};
for (const h of hits) (byFile[h.file] ??= []).push(`${h.line}: ${h.text.trim().slice(0, 120)}`);
return Object.entries(byFile)
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, args.limit ?? 20)
  .map(([file, items]) => ({ file, count: items.length, items }));
