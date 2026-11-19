// @description Local stack: what is up, what is down with the command to start it, and recent errors of unhealthy containers
// @param all boolean? include optional services
// @param logs boolean? also return error lines of unhealthy containers (default true)

const s = await stackStatus({ all: !!args.all });
if (s.error || args.logs === false || !s.unhealthy?.length) return s;
const logs = Object.fromEntries(await Promise.all(s.unhealthy.map(async (c) => [c, await containerLogs(c, { limit: 15 })])));
return { ...s, logs };
