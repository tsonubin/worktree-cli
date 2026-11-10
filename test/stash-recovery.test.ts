import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyAndDropStash, readStashRecord, stashChanges, stashRecordPath } from '../src/utils/git.js';

describe('durable stash recovery', () => {
    let testDir: string;
    let repo: string;

    beforeEach(async () => {
        testDir = await mkdtemp(join(tmpdir(), 'wt-stash-recovery-'));
        repo = join(testDir, 'repo');
        await mkdir(repo);
        await git('init', '-b', 'main');
        await git('config', 'user.name', 'Test User');
        await git('config', 'user.email', 'test@example.com');
        await writeFile(join(repo, 'README.md'), 'original\n');
        await git('add', '.');
        await git('commit', '-m', 'Initial');
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(testDir, { recursive: true, force: true });
    });

    async function git(...args: string[]) {
        return execa('git', ['-C', repo, ...args]);
    }

    async function makeChanges() {
        await writeFile(join(repo, 'README.md'), 'staged\n');
        await git('add', 'README.md');
        await writeFile(join(repo, 'README.md'), 'unstaged\n');
        await writeFile(join(repo, 'untracked file.txt'), 'untracked data\n');
    }

    async function snapshot() {
        return {
            status: (await git('status', '--porcelain', '-z')).stdout,
            staged: (await git('diff', '--cached', '--binary')).stdout,
            unstaged: (await git('diff', '--binary')).stdout,
            untracked: await readFile(join(repo, 'untracked file.txt'), 'utf8'),
        };
    }

    it.each([false, true])('survives pruning and restores the index and files (linked worktree: %s)', async (linked) => {
        if (linked) {
            const linkedRepo = join(testDir, 'linked');
            await git('worktree', 'add', '-b', 'linked', linkedRepo);
            repo = linkedRepo;
        }
        await makeChanges();
        const before = await snapshot();
        const hash = await stashChanges(repo, 'GC safety');
        expect(hash).toBeTruthy();
        const record = await readStashRecord(repo);
        expect(record?.recoveryRef).toMatch(/^refs\/wt\/stashes\//);

        await git('reflog', 'expire', '--expire=now', '--all');
        await git('gc', '--prune=now');
        expect((await git('cat-file', '-t', hash!)).stdout).toBe('commit');
        expect((await git('rev-parse', record!.recoveryRef!)).stdout).toBe(hash);
        expect(await applyAndDropStash(hash!, repo)).toBe(true);
        expect(await snapshot()).toEqual(before);
        expect(await readStashRecord(repo)).toBeNull();
        expect((await git('for-each-ref', '--format=%(refname)', 'refs/wt/stashes')).stdout).toBe('');
    });

    it('fails before changing files or index when recovery metadata cannot be written', async () => {
        await makeChanges();
        const before = await snapshot();
        await mkdir(await stashRecordPath(repo));

        await expect(stashChanges(repo, 'record failure')).rejects.toThrow();

        expect(await snapshot()).toEqual(before);
        // Even a failed metadata write leaves a Git-rooted backup of the data.
        const { stdout: refs } = await git('for-each-ref', '--format=%(refname)', 'refs/wt/stashes');
        expect(refs).toMatch(/^refs\/wt\/stashes\/[0-9a-f-]+$/);
    });

    it('fails before changing files or index when the recovery ref cannot be written', async () => {
        await makeChanges();
        const before = await snapshot();
        await writeFile(join(repo, '.git', 'refs', 'wt'), 'block the recovery ref namespace');

        await expect(stashChanges(repo, 'ref failure')).rejects.toThrow();

        expect(await snapshot()).toEqual(before);
        expect(await readStashRecord(repo)).toBeNull();
    });

    it('does not overwrite an existing recovery record', async () => {
        await makeChanges();
        const before = await snapshot();
        const recordPath = await stashRecordPath(repo);
        const existingRecord = JSON.stringify({ hash: (await git('rev-parse', 'HEAD')).stdout, message: 'keep me' });
        await writeFile(recordPath, existingRecord);

        await expect(stashChanges(repo, 'another stash')).rejects.toThrow();

        expect(await readFile(recordPath, 'utf8')).toBe(existingRecord);
        expect(await snapshot()).toEqual(before);
    });

    it('retains the recovery ref and record when applying the stash fails', async () => {
        await makeChanges();
        const hash = await stashChanges(repo, 'restore conflict');
        expect(hash).toBeTruthy();
        const record = await readStashRecord(repo);
        await writeFile(join(repo, 'README.md'), 'conflicting local change\n');

        expect(await applyAndDropStash(hash!, repo)).toBe(false);

        expect((await readStashRecord(repo))?.hash).toBe(hash);
        await git('reflog', 'expire', '--expire=now', '--all');
        await git('gc', '--prune=now');
        expect((await git('cat-file', '-t', hash!)).stdout).toBe('commit');
        expect((await git('rev-parse', record!.recoveryRef!)).stdout).toBe(hash);
        expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('conflicting local change\n');
    });

    it.each([false, true])('preserves index changes made while stashed (linked worktree: %s)', async (linked) => {
        await writeFile(join(repo, 'unrelated.txt'), 'version A\n');
        await git('add', 'unrelated.txt');
        await git('commit', '-m', 'Track unrelated file');
        if (linked) {
            const linkedRepo = join(testDir, 'linked');
            await git('worktree', 'add', '-b', 'linked', linkedRepo);
            repo = linkedRepo;
        }
        await makeChanges();
        const original = await snapshot();
        const hash = await stashChanges(repo, 'index drift');
        const record = await readStashRecord(repo);
        await writeFile(join(repo, 'unrelated.txt'), 'version B\n');
        await git('add', 'unrelated.txt');
        await writeFile(join(repo, 'unrelated.txt'), 'version C\n');
        const staged = (await git('diff', '--cached', '--binary')).stdout;
        const unstaged = (await git('diff', '--binary')).stdout;

        expect(await applyAndDropStash(hash!, repo)).toBe(false);

        expect((await git('show', ':unrelated.txt')).stdout).toBe('version B');
        expect(await readFile(join(repo, 'unrelated.txt'), 'utf8')).toBe('version C\n');
        expect((await git('diff', '--cached', '--binary')).stdout).toBe(staged);
        expect((await git('diff', '--binary')).stdout).toBe(unstaged);
        expect(await readStashRecord(repo)).toEqual(record);
        await git('reflog', 'expire', '--expire=now', '--all');
        await git('gc', '--prune=now');
        expect((await git('rev-parse', record!.recoveryRef!)).stdout).toBe(hash);
        // Once the new changes have been saved separately, the original stash
        // remains recoverable with its exact staged/unstaged/untracked split.
        await git('stash', 'push', '-m', 'Save concurrent work');
        expect(await applyAndDropStash(hash!, repo)).toBe(true);
        expect(await snapshot()).toEqual(original);
    });

    it('does not change the user stash stack', async () => {
        await writeFile(join(repo, 'README.md'), 'existing user stash\n');
        await git('stash', 'push', '-m', 'user stash');
        const { stdout: originalStash } = await git('rev-parse', 'refs/stash');
        await makeChanges();

        const hash = await stashChanges(repo, 'separate recovery ref');
        expect(await applyAndDropStash(hash!, repo)).toBe(true);

        expect((await git('rev-parse', 'refs/stash')).stdout).toBe(originalStash);
    });

    it('still restores legacy recovery records that have no dedicated ref', async () => {
        await makeChanges();
        const before = await snapshot();
        const hash = await stashChanges(repo, 'legacy record');
        const record = await readStashRecord(repo);
        expect(record).not.toBeNull();
        await git('update-ref', '-d', record!.recoveryRef!, hash!);
        delete record!.recoveryRef;
        await writeFile(await stashRecordPath(repo), JSON.stringify(record));

        expect(await applyAndDropStash(hash!, repo)).toBe(true);

        expect(await snapshot()).toEqual(before);
        expect(await readStashRecord(repo)).toBeNull();
    });

    it('keeps identical snapshots from overlapping operations independently rooted', async () => {
        vi.stubEnv('GIT_AUTHOR_DATE', '2000-01-01T00:00:00Z');
        vi.stubEnv('GIT_COMMITTER_DATE', '2000-01-01T00:00:00Z');
        await makeChanges();
        const before = await snapshot();
        const firstHash = await stashChanges(repo, 'identical snapshot');
        const first = await readStashRecord(repo);

        // Pause the first operation after restoration and record removal, but
        // before its ref cleanup. A second operation can now write its record.
        await git('stash', 'apply', firstHash!);
        await git('read-tree', '--reset', `${first!.indexCommit}^{tree}`);
        await rm(await stashRecordPath(repo));
        const secondHash = await stashChanges(repo, 'identical snapshot');
        const second = await readStashRecord(repo);
        expect(secondHash).toBe(firstHash);
        expect(second!.recoveryRef).not.toBe(first!.recoveryRef);

        await git('update-ref', '-d', first!.recoveryRef!, firstHash!);
        await git('reflog', 'expire', '--expire=now', '--all');
        await git('gc', '--prune=now');

        expect((await git('rev-parse', second!.recoveryRef!)).stdout).toBe(secondHash);
        expect(await applyAndDropStash(secondHash!, repo)).toBe(true);
        expect(await snapshot()).toEqual(before);
    });

    it('aborts the CLI command rather than creating a worktree after persistence fails', async () => {
        await makeChanges();
        const before = await snapshot();
        await mkdir(await stashRecordPath(repo));
        const result = await execa(process.execPath, [
            resolve(__dirname, '../build/index.js'), 'new', 'must-not-be-created',
            '--path', join(testDir, 'new-worktree'), '--stash', '--editor', 'echo',
        ], {
            cwd: repo,
            reject: false,
            env: { XDG_CONFIG_HOME: join(testDir, 'config'), APPDATA: join(testDir, 'config'), WT_EDITOR: 'echo' },
        });

        expect(result.exitCode).toBe(1);
        expect(await snapshot()).toEqual(before);
        expect((await git('branch', '--list', 'must-not-be-created')).stdout).toBe('');
    });
    it.each(['bash', 'zsh'])('combines auto-cd with faithful stash restoration in %s', async (shell) => {
        await runWrappedStash(shell, false);
    });

    it.each(['bash', 'zsh'])('keeps %s in the source directory and exits nonzero when restoration fails', async (shell) => {
        await runWrappedStash(shell, true);
    });

    it.each(['bash', 'zsh'])('preserves a new staged version and fails safely after editor index changes in %s', async (shell) => {
        await runWrappedStash(shell, true, true);
    });

    async function runWrappedStash(shell: string, conflict: boolean, indexDrift = false) {
        if (indexDrift) {
            await writeFile(join(repo, 'unrelated.txt'), 'version A\n');
            await git('add', 'unrelated.txt');
            await git('commit', '-m', 'Track unrelated file');
        }
        await makeChanges();
        const before = await snapshot();
        const bin = join(testDir, 'bin');
        await mkdir(bin);
        const cli = resolve(__dirname, '../build/index.js');
        await symlink(cli, join(bin, 'wt'));
        const target = join(testDir, 'target with spaces');
        const cwdResult = join(testDir, 'shell-cwd');
        const editor = join(bin, 'conflicting-editor');
        await writeFile(editor, '#!/bin/sh\nprintf "conflicting local change\\n" > "$WT_SOURCE/README.md"\n');
        if (indexDrift) {
            await writeFile(editor, `#!/bin/sh
printf 'version B\\n' > "$WT_SOURCE/unrelated.txt"
git -C "$WT_SOURCE" add unrelated.txt
printf 'version C\\n' > "$WT_SOURCE/unrelated.txt"
`);
        }
        await chmod(editor, 0o755);
        const result = await execa(shell, ['-c', `
            eval "$(wt shellenv ${shell})"
            wt new combined --path "$WT_TARGET" --stash -d --editor "$WT_EDITOR"
            result=$?
            pwd -P > "$WT_CWD_RESULT"
            exit $result
        `], {
            cwd: repo,
            reject: false,
            env: {
                PATH: `${bin}:${process.env.PATH}`,
                WT_TARGET: target,
                WT_SOURCE: repo,
                WT_CWD_RESULT: cwdResult,
                WT_EDITOR: conflict ? editor : 'none',
                XDG_CONFIG_HOME: join(testDir, 'config'),
                APPDATA: join(testDir, 'config'),
            },
        });
        expect(result.exitCode, result.all ?? result.stderr).toBe(conflict ? 1 : 0);
        expect((await readFile(cwdResult, 'utf8')).trim()).toBe(await realpath(conflict ? repo : target));
        if (conflict) {
            const record = await readStashRecord(repo);
            expect(record?.hash).toBeTruthy();
            expect((await git('rev-parse', record!.recoveryRef!)).stdout).toBe(record!.hash);
            if (indexDrift) {
                expect(result.stderr).toContain('source index changed');
                expect((await git('show', ':unrelated.txt')).stdout).toBe('version B');
                expect(await readFile(join(repo, 'unrelated.txt'), 'utf8')).toBe('version C\n');
                expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('original\n');
            } else {
                expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('conflicting local change\n');
            }
        } else {
            expect(await snapshot()).toEqual(before);
            expect(await readStashRecord(repo)).toBeNull();
        }
    }

});
