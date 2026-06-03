export const encodeCwdForProjects = (cwd: string): string =>
  cwd.replace(/[^a-zA-Z0-9]/g, "-");
