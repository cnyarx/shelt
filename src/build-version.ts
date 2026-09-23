export type BuildVersion = { version: string; commit: string; dirty: boolean };

export function buildVersion(commit: string, dirty: boolean, releaseTag?: string): BuildVersion {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid build commit");
  if (releaseTag && !/^v0\.0\.(0|[1-9][0-9]*)$/.test(releaseTag)) throw new Error("Invalid release tag");
  if (releaseTag && dirty) throw new Error("Release build has uncommitted changes");
  return { version: releaseTag || "开发版", commit: commit.slice(0, 7), dirty };
}
