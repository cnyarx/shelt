import type { BuildVersion } from "./build-version.ts";

type Status = { currentVersion: string; latestVersion: string | null; available: boolean; canInstall: false; reason: string; phase: "idle"; error: string | null };
let cached: { until: number; value: Status } | undefined;
let checking: Promise<Status> | undefined;

export async function checkSourceUpdate(build: BuildVersion): Promise<Status> {
  if (cached && cached.until > Date.now()) return cached.value;
  if (checking) return checking;
  checking = (async () => {
    const status: Status = { currentVersion: build.version, latestVersion: null, available: false, canInstall: false, reason: "updateSourceMode", phase: "idle", error: null };
    try {
      const response = await fetch("https://api.github.com/repos/cnyarx/shelt/releases/latest", {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Shelt-Updater" }, signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? "updateRateLimited" : "updateCheckFailed");
      const release = await response.json() as { tag_name: string; draft: boolean; prerelease: boolean };
      if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(release.tag_name) || release.draft || release.prerelease) throw new Error("updateInvalidRelease");
      status.latestVersion = release.tag_name;
      const latest = release.tag_name.slice(1).split(".").map(Number);
      const current = /^v\d+\.\d+\.\d+$/.test(build.version) ? build.version.slice(1).split(".").map(Number) : null;
      status.available = current === null || latest.some((value, i) => latest.slice(0, i).every((part, j) => part === current[j]) && value > current[i]!);
    } catch (error) { status.error = error instanceof Error && error.message.startsWith("update") ? error.message : "updateCheckFailed"; }
    cached = { until: Date.now() + (status.error ? 300_000 : 3_600_000), value: status };
    return status;
  })();
  try { return await checking; } finally { checking = undefined; }
}
