export { run, VERSION } from "./cli.ts";
export type { CliContext, CliDeps, InputStream, OutputStream, SpawnedDaemon } from "./context.ts";
export { EXIT, type ExitCode } from "./exit-codes.ts";
export { realContext, runCli } from "./main.ts";
