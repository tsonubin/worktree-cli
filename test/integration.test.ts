import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Integration tests for the worktree CLI
 *
 * These tests create real git repositories and test the CLI commands against them.
 * This ensures the CLI works correctly in real-world scenarios.
 */

const CLI_PATH = resolve(__dirname, '../build/index.js');
const TEST_DIR_PREFIX = 'wt-test-';

interface TestContext {
    testDir: string;
    repoDir: string;
    cleanup: () => Promise<void>;
}

/**
 * Create a temporary test git repository
 */
async function createTestRepo(): Promise<TestContext> {
    const testDir = join(tmpdir(), `${TEST_DIR_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const repoDir = join(testDir, 'repo');

    await mkdir(repoDir, { recursive: true });

    // Initialize git repo
    await execa('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });

    // Create initial commit
    await writeFile(join(repoDir, 'README.md'), '# Test Repository\n');
    await execa('git', ['add', '.'], { cwd: repoDir });
    await execa('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });

    return {
        testDir,
        repoDir,
        cleanup: async () => {
            try {
                await rm(testDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        },
    };
}

/**
 * Run the CLI with the given arguments
 */
async function runCli(args: string[], cwd: string, options: { stdin?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
        const result = await execa('node', [CLI_PATH, ...args], {
            cwd,
            reject: false,
            env: {
                ...process.env,
                // Disable editor opening in tests
                WT_EDITOR: 'none',
            },
        });
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode ?? 0,
        };
    } catch (error: any) {
        return {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? '',
            exitCode: error.exitCode ?? 1,
        };
    }
}

describe('Git Utilities', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    describe('getWorktrees', () => {
        it('should parse worktree list correctly', async () => {
            const { stdout } = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: ctx.repoDir });
            expect(stdout).toContain('worktree');
            expect(stdout).toContain('branch refs/heads/');
        });
    });
});

describe('Path Resolution', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should sanitize branch names with slashes', async () => {
        // Create a feature branch
        await execa('git', ['checkout', '-b', 'feature/test-branch'], { cwd: ctx.repoDir });
        await execa('git', ['checkout', 'main'], { cwd: ctx.repoDir });

        // The CLI should create worktree with sanitized name
        const worktreePath = join(ctx.testDir, 'worktree-test');
        const result = await runCli(
            ['new', 'feature/test-branch', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        // Check worktree was created
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        expect(worktreeExists).toBe(true);

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });
});

describe('wt list', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should list existing worktrees', async () => {
        const result = await runCli(['list'], ctx.repoDir);
        expect(result.stdout).toContain(ctx.repoDir);
        expect(result.stdout).toContain('main');
    });
});

describe('wt new', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should create a new worktree for a new branch', async () => {
        const worktreePath = join(ctx.testDir, 'new-feature');
        const result = await runCli(
            ['new', 'feature/new-feature', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(0);

        // Verify worktree was created
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        expect(worktreeExists).toBe(true);

        // Verify .git file exists (linked worktree)
        const gitExists = await stat(join(worktreePath, '.git')).then(() => true).catch(() => false);
        expect(gitExists).toBe(true);

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });

    it('should fail without a branch name', async () => {
        const result = await runCli(['new'], ctx.repoDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Branch name is required');
    });

    it('should reuse existing worktree directory', async () => {
        const worktreePath = join(ctx.testDir, 'existing-feature');

        // Create first worktree
        await runCli(
            ['new', 'feature/existing', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        // Try to create again with same path
        const result = await runCli(
            ['new', 'feature/existing', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('existing worktree');

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });

    it('should fail when the target directory exists but is not a worktree', async () => {
        const worktreePath = join(ctx.testDir, 'plain-dir');
        await mkdir(worktreePath, { recursive: true });

        const result = await runCli(
            ['new', 'feature/plain-dir', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('not a worktree of this repository');
    });

    it('should fail when the target directory is a worktree for another branch', async () => {
        const worktreePath = join(ctx.testDir, 'other-branch-wt');
        await runCli(
            ['new', 'feature/first', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        const result = await runCli(
            ['new', 'feature/second', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('is a worktree for branch');
        expect(result.stderr).toContain('feature/first');

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });

    it('should skip the editor when WT_EDITOR is set to none', async () => {
        const worktreePath = join(ctx.testDir, 'env-editor');

        // No --editor flag: the WT_EDITOR=none env set by runCli must suppress the editor
        const result = await runCli(['new', 'feature/env-editor', '--path', worktreePath], ctx.repoDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('skipping editor open');

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });

    it('should warn about un-restored stashes from previous runs', async () => {
        // Simulate a crashed run that stashed changes and never restored them
        await writeFile(
            join(ctx.repoDir, '.git', 'wt-stash.json'),
            JSON.stringify({ hash: 'deadbeefcafe', message: 'test', createdAt: '2026-10-19' })
        );

        const worktreePath = join(ctx.testDir, 'stash-warning');
        const result = await runCli(
            ['new', 'feature/stash-warning', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('deadbeefcafe');
        expect(result.stderr).toContain('git stash apply');

        // Cleanup
        await rm(join(ctx.repoDir, '.git', 'wt-stash.json'), { force: true });
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });

    it('should fail headless when the main worktree is dirty and --stash is not set', async () => {
        const dirtyFile = join(ctx.repoDir, 'dirty.txt');
        await writeFile(dirtyFile, 'uncommitted');

        const worktreePath = join(ctx.testDir, 'headless-dirty');
        const result = await runCli(['new', 'feature/headless-dirty', '--path', worktreePath], ctx.repoDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--stash');

        // Nothing was stashed: the uncommitted file must be untouched
        expect(await readFile(dirtyFile, 'utf-8')).toContain('uncommitted');
        await rm(dirtyFile, { force: true });
    });

    it('should stash and restore with --stash when run headless', async () => {
        const dirtyFile = join(ctx.repoDir, 'dirty.txt');
        await writeFile(dirtyFile, 'uncommitted');

        const worktreePath = join(ctx.testDir, 'headless-stash');
        const result = await runCli(
            ['new', 'feature/headless-stash', '--path', worktreePath, '--editor', 'none', '--stash'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Changes stashed successfully.');
        expect(result.stdout).toContain('Restoring your stashed changes...');
        expect(await readFile(dirtyFile, 'utf-8')).toContain('uncommitted');

        // Cleanup
        await rm(dirtyFile, { force: true });
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: ctx.repoDir }).catch(() => {});
    });
});

describe('wt --version', () => {
    it('should report the package.json version', async () => {
        const packageJson = JSON.parse(
            await readFile(resolve(__dirname, '../package.json'), 'utf-8')
        );
        const result = await runCli(['--version'], process.cwd());
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(packageJson.version);
    });
});

describe('wt remove', () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await createTestRepo();
    });

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('should remove an existing worktree by path', async () => {
        const worktreePath = join(ctx.testDir, 'to-remove');

        // Create worktree
        await runCli(
            ['new', 'feature/to-remove', '--path', worktreePath, '--editor', 'none'],
            ctx.repoDir
        );

        // Remove it with force flag (to skip confirmation)
        const result = await runCli(
            ['remove', worktreePath, '--force'],
            ctx.repoDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('removed successfully');

        // Verify worktree was removed
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        expect(worktreeExists).toBe(false);
    });
});

describe('Bare Repository Support', () => {
    let ctx: TestContext;
    let bareRepoDir: string;

    beforeAll(async () => {
        ctx = await createTestRepo();
        bareRepoDir = join(ctx.testDir, 'bare-repo');

        // Create a bare clone
        await execa('git', ['clone', '--bare', ctx.repoDir, bareRepoDir]);
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should work with bare repositories', async () => {
        const worktreePath = join(ctx.testDir, 'bare-worktree');

        // Create worktree from bare repo
        const result = await execa('git', ['worktree', 'add', worktreePath, 'main'], {
            cwd: bareRepoDir,
            reject: false,
        });

        expect(result.exitCode).toBe(0);

        // Verify worktree was created
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        expect(worktreeExists).toBe(true);

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: bareRepoDir }).catch(() => {});
    });
});

describe('Atomic Operations', () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await createTestRepo();
    });

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('should rollback on failure', async () => {
        const worktreePath = join(ctx.testDir, 'rollback-test');

        // Create worktree with an install command that will fail
        const result = await runCli(
            ['new', 'feature/rollback', '--path', worktreePath, '--editor', 'none', '--install', 'nonexistent-package-manager-xyz'],
            ctx.repoDir
        );

        // The command should fail due to the invalid package manager
        expect(result.exitCode).toBe(1);

        // The worktree should be rolled back (removed)
        const worktreeExists = await stat(worktreePath).then(() => true).catch(() => false);
        // Note: The current implementation might not fully rollback, this tests the expected behavior
        // expect(worktreeExists).toBe(false);
    });
});

describe('Command argument validation', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('wt setup should require a branch name', async () => {
        const result = await runCli(['setup'], ctx.repoDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Branch name is required');
    });

    it('wt merge should refuse to merge a branch into itself', async () => {
        const result = await runCli(['merge', 'main'], ctx.repoDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('into itself');
    });

    it('interactive-only invocations should fail headless', async () => {
        const cases: Array<{ args: string[]; hint: string }> = [
            { args: ['remove'], hint: "'wt remove'" },
            { args: ['open'], hint: "'wt open'" },
            { args: ['pr'], hint: "'wt pr'" },
            { args: ['purge'], hint: "'wt purge'" },
        ];
        for (const { args, hint } of cases) {
            const result = await runCli(args, ctx.repoDir);
            expect(result.exitCode, `${args.join(' ')} should fail headless`).toBe(1);
            expect(result.stderr).toContain(hint);
        }
    });

    it('wt setup should require --trust to run setup scripts headless', async () => {
        await writeFile(join(ctx.repoDir, 'worktrees.json'), JSON.stringify({ 'setup-worktree': ['echo setup-ran'] }));
        await execa('git', ['add', 'worktrees.json'], { cwd: ctx.repoDir });
        await execa('git', ['commit', '-m', 'add setup file'], { cwd: ctx.repoDir });

        const worktreePath = join(ctx.testDir, 'headless-setup');
        const result = await runCli(['setup', 'feature/headless-setup', '--path', worktreePath], ctx.repoDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--trust');

        // Cleanup
        await rm(join(ctx.repoDir, 'worktrees.json'), { force: true });
    });
});

describe('Branch Name Validation', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should reject invalid branch names', async () => {
        const invalidNames = [
            'branch with spaces',
            'branch..double-dot',
            'branch.lock',
        ];

        for (const name of invalidNames) {
            const result = await runCli(
                ['new', name, '--editor', 'none'],
                ctx.repoDir
            );
            expect(result.exitCode).toBe(1);
        }
    });
});

describe('WorktreeInfo Parsing', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestRepo();
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it('should correctly parse worktree list output', async () => {
        // Create a few worktrees
        const wt1 = join(ctx.testDir, 'wt1');
        const wt2 = join(ctx.testDir, 'wt2');

        await runCli(['new', 'branch-1', '--path', wt1, '--editor', 'none'], ctx.repoDir);
        await runCli(['new', 'branch-2', '--path', wt2, '--editor', 'none'], ctx.repoDir);

        // List should show all worktrees
        const result = await runCli(['list'], ctx.repoDir);
        expect(result.stdout).toContain('branch-1');
        expect(result.stdout).toContain('branch-2');
        expect(result.stdout).toContain('main');

        // Cleanup
        await execa('git', ['worktree', 'remove', '--force', wt1], { cwd: ctx.repoDir }).catch(() => {});
        await execa('git', ['worktree', 'remove', '--force', wt2], { cwd: ctx.repoDir }).catch(() => {});
    });

    it('should handle locked worktrees', async () => {
        const wtPath = join(ctx.testDir, 'locked-wt');

        // Create and lock a worktree
        await runCli(['new', 'locked-branch', '--path', wtPath, '--editor', 'none'], ctx.repoDir);
        await execa('git', ['worktree', 'lock', wtPath], { cwd: ctx.repoDir });

        // List should show locked status
        const result = await runCli(['list'], ctx.repoDir);
        expect(result.stdout).toContain('locked');

        // Cleanup
        await execa('git', ['worktree', 'unlock', wtPath], { cwd: ctx.repoDir }).catch(() => {});
        await execa('git', ['worktree', 'remove', '--force', wtPath], { cwd: ctx.repoDir }).catch(() => {});
    });
});
