import { writeFileSync } from "node:fs";
/**
 * If `WT_CD_FILE` is set, write the target path so the shell wrapper
 * (installed via `wt shellenv`) can cd into it after `wt` exits.
 * No-op otherwise — failures are swallowed since cd is best-effort.
 */
export function writeCdTarget(targetPath) {
    const cdFile = process.env.WT_CD_FILE;
    if (!cdFile || !targetPath)
        return;
    try {
        writeFileSync(cdFile, targetPath, "utf8");
    }
    catch {
        // best-effort — the user just won't auto-cd this time
    }
}
