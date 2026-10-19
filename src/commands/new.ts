import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { findWorktreeByPath, getUpstreamRemote, validateGitRepo } from "../utils/git.js";
import { guardDirtyState } from "../utils/dirty.js";
import type { DirtyStateGuard } from "../utils/dirty.js";
import { openInEditor } from "../utils/editor.js";
import { resolveWorktreePath, validateBranchName } from "../utils/paths.js";
import { AtomicWorktreeOperation } from "../utils/atomic.js";

export async function newWorktreeHandler(
    branchName?: string,
    options: { path?: string; checkout?: boolean; install?: string; editor?: string; stash?: boolean } = {}
) {
    let guard: DirtyStateGuard | undefined;

    try {
        // 1. Validate we're in a git repo
        await validateGitRepo();

        // Validate branch name is provided
        if (!branchName || branchName.trim() === "") {
            console.error(chalk.red("Error: Branch name is required."));
            console.error(chalk.yellow("Usage: wt new <branchName> [options]"));
            console.error(chalk.cyan("Example: wt new feature/my-feature --checkout"));
            process.exit(1);
        }

        // Validate branch name format
        const validation = validateBranchName(branchName);
        if (!validation.isValid) {
            console.error(chalk.red(`Error: ${validation.error}`));
            process.exit(1);
        }

        // 2-3. Protect uncommitted changes in the main worktree (stash/restore)
        guard = await guardDirtyState(`wt-new: Before creating worktree for ${branchName}`);

        // 4. Build final path for the new worktree (Improvement #1 & #7)
        const resolvedPath = await resolveWorktreePath(branchName, {
            customPath: options.path,
            useRepoNamespace: true,  // Prevent global path collisions
        });

        // Check if directory already exists
        let directoryExists = false;
        try {
            await stat(resolvedPath);
            directoryExists = true;
        } catch {
            // Directory doesn't exist, continue with creation
        }

        // 5. Check if branch exists
        const remote = await getUpstreamRemote();
        const { stdout: localBranches } = await execa("git", ["branch", "--list", branchName]);
        const { stdout: remoteBranches } = await execa("git", ["branch", "-r", "--list", `${remote}/${branchName}`]);
        const branchExists = !!localBranches || !!remoteBranches;

        // 6. Create the new worktree or open the editor if it already exists
        if (directoryExists) {
            console.log(chalk.yellow(`Directory already exists at: ${resolvedPath}`));

            const existingWorktree = await findWorktreeByPath(resolvedPath);
            if (!existingWorktree) {
                console.error(chalk.red(`Error: Directory "${resolvedPath}" exists but is not a worktree of this repository.`));
                console.error(chalk.yellow("Please remove it or choose a different path with the --path option."));
                process.exitCode = 1;
                return;
            }

            if (existingWorktree.branch !== branchName) {
                console.error(chalk.red(`Error: Directory "${resolvedPath}" is a worktree for branch "${existingWorktree.branch ?? "(detached)"}", not "${branchName}".`));
                console.error(chalk.yellow("Please choose a different path with the --path option."));
                process.exitCode = 1;
                return;
            }

            console.log(chalk.green(`Using existing worktree at: ${resolvedPath}`));
        } else {
            console.log(chalk.blue(`Creating new worktree for branch "${branchName}" at: ${resolvedPath}`));

            // Improvement #2: Support for bare repositories
            // Skip the bare check - bare repos work fine with worktrees

            // Improvement #9: Atomic operations with rollback
            const atomic = new AtomicWorktreeOperation();

            try {
                if (!branchExists) {
                    console.log(chalk.yellow(`Branch "${branchName}" doesn't exist. Creating new branch with worktree...`));
                    await atomic.createWorktree(resolvedPath, branchName, true);
                } else {
                    console.log(chalk.green(`Using existing branch "${branchName}".`));
                    await atomic.createWorktree(resolvedPath, branchName, false);
                }

                // Run install if specified
                if (options.install) {
                    await atomic.runInstall(options.install, resolvedPath);
                }

                // Commit the atomic operation
                atomic.commit();
            } catch (error: any) {
                console.error(chalk.red("Failed to create worktree:"), error.message);
                await atomic.rollback();
                throw error;
            }
        }

        // 7. Open in the specified editor (or use configured default)
        const outcome = await openInEditor(resolvedPath, options.editor);
        if (outcome === "failed") {
            console.warn(chalk.yellow(`Continuing without opening editor.`));
        }

        console.log(chalk.green(`Worktree ${directoryExists ? "opened" : "created"} at ${resolvedPath}.`));
        if (!directoryExists && options.install) {
            console.log(chalk.green(`Dependencies installed using ${options.install}.`));
        }

    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to create new worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to create new worktree:"), error);
        }
        process.exitCode = 1;
    } finally {
        await guard?.finish();
    }
}
