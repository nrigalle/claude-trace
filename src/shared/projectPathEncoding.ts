export const encodeCwdForProjects = (cwd: string): string =>
  cwd.replace(/[\\/:]/g, "-");
