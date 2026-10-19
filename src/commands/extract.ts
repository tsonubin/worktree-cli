import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { getWorktrees, getUpstreamRemote, validateGitRepo } from "../utils/git.js";
import { guardDirtyState } from "../utils/dirty.js";
import type { DirtyStateGuard } from "../utils/dirty.js";
import { openInEditor } from "../utils/editor.js";
import { resolveWorktreePath, validateBranchName } from "../utils/paths.js";
import { AtomicWorktreeOperation } from "../utils/atomic.js";

export async function extractWorktreeHandler(
    branchName?: string,
    options: { path?: string; install?: string; editor?: string } = {}
) {
    let guard: DirtyStateGuard | undefined;

    try {
        // 1. Validate we're in a git repo
        await validateGitRepo();

        // 2-3. Protect uncommitted changes in the main worktree (stash/restore)
        guard = await guardDirtyState(`wt-extract: Before extracting worktree`);

        // 4. Determine which branch to extract
        let selectedBranch = branchName;
        if (!selectedBranch) {
            const { stdout: currentBranch } = await execa("git", ["branch", "--show-current"]);
            selectedBranch = currentBranch.trim();

            if (!selectedBranch) {
                console.error(chalk.red("Error: Could not determine current branch (possibly in detached HEAD state)."));
                console.error(chalk.yellow("Please specify a branch name: wt extract <branch-name>"));
                process.exitCode = 1;
                return;
            }

            console.log(chalk.blue(`No branch specified. Using current branch: ${selectedBranch}`));
        }

        // Validate branch name
        const validation = validateBranchName(selectedBranch);
        if (!validation.isValid) {
            console.error(chalk.red(`Error: ${validation.error}`));
            process.exitCode = 1;
            return;
        }

        // 5. Check if branch already has a worktree
        const worktrees = await getWorktrees();
        const existingWorktree = worktrees.find(wt => wt.branch === selectedBranch);

        if (existingWorktree) {
            console.error(chalk.red(`Error: Branch "${selectedBranch}" already has a worktree at ${existingWorktree.path}.`));
            console.error(chalk.yellow("Use 'wt list' to see existing worktrees."));
            process.exitCode = 1;
            return;
        }

        // 6. Verify the branch exists (either locally or remotely)
        const remote = await getUpstreamRemote();
        const { stdout: localBranches } = await execa("git", ["branch", "--format=%(refname:short)"]);
        const { stdout: remoteBranches } = await execa("git", ["branch", "-r", "--format=%(refname:short)"]);

        const localBranchList = localBranches.split('\n').filter(b => b.trim() !== '');
        const remoteBranchList = remoteBranches
            .split('\n')
            .filter(b => b.trim() !== '' && b.startsWith(`${remote}/`))
            .map(b => b.replace(`${remote}/`, ''));

        const branchExistsLocally = localBranchList.includes(selectedBranch);
        const branchExistsRemotely = remoteBranchList.includes(selectedBranch);

        if (!branchExistsLocally && !branchExistsRemotely) {
            console.error(chalk.red(`Error: Branch "${selectedBranch}" does not exist locally or remotely.`));
            process.exitCode = 1;
            return;
        }

        // 7. Build final path for the new worktree
        const resolvedPath = await resolveWorktreePath(selectedBranch, {
            customPath: options.path,
            useRepoNamespace: true,
        });

        // Check if directory already exists
        try {
            await stat(resolvedPath);
            console.error(chalk.red(`Error: Directory already exists at: ${resolvedPath}`));
            console.error(chalk.yellow("Please choose a different path with --path option."));
            process.exitCode = 1;
            return;
        } catch {
            // Directory doesn't exist, continue with creation
        }

        // 8. Create the worktree using atomic operations
        console.log(chalk.blue(`Extracting branch "${selectedBranch}" to worktree at: ${resolvedPath}`));

        const atomic = new AtomicWorktreeOperation();

        try {
            if (!branchExistsLocally && branchExistsRemotely) {
                console.log(chalk.yellow(`Branch "${selectedBranch}" is remote-only. Creating local tracking branch...`));
                await atomic.createWorktreeFromRemote(resolvedPath, selectedBranch, `${remote}/${selectedBranch}`);
            } else {
                await atomic.createWorktree(resolvedPath, selectedBranch, false);
            }

            console.log(chalk.green(`Successfully extracted branch "${selectedBranch}" to worktree.`));

            // 9. Install dependencies if specified
            if (options.install) {
                await atomic.runInstall(options.install, resolvedPath);
            }

            atomic.commit();
        } catch (error: any) {
            console.error(chalk.red("Failed to extract worktree:"), error.message);
            await atomic.rollback();
            throw error;
        }

        // 10. Open in the specified editor (or use configured default)
        const outcome = await openInEditor(resolvedPath, options.editor);
        if (outcome === "failed") {
            console.warn(chalk.yellow(`Continuing without opening editor.`));
        }

        console.log(chalk.green(`\nWorktree extracted at ${resolvedPath}.`));
        if (options.install) {
            console.log(chalk.green(`Dependencies installed using ${options.install}.`));
        }

    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to extract worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to extract worktree:"), error);
        }
        process.exitCode = 1;
    } finally {
        await guard?.finish();
    }
}
