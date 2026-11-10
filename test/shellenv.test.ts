import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = resolve(__dirname, '../build/index.js');
let testConfigDir: string;

beforeAll(async () => {
    testConfigDir = await mkdtemp(join(tmpdir(), 'wt-shellenv-test-'));
});

afterAll(async () => {
    await rm(testConfigDir, { recursive: true, force: true });
});

async function runShellenv(shellPath: string | undefined, shell?: string) {
    return execa(process.execPath, [CLI_PATH, 'shellenv', ...(shell ? [shell] : [])], {
        reject: false,
        env: {
            SHELL: shellPath,
            FORCE_COLOR: '0',
            XDG_CONFIG_HOME: testConfigDir,
            APPDATA: testConfigDir,
        },
    });
}

describe('shellenv', () => {
    it.each([
        ['/bin/bash', 'wt() {'],
        ['/bin/zsh', 'wt() {'],
        ['/usr/local/bin/fish', 'function wt'],
    ])('detects the supported shell %s', async (shellPath, prefix) => {
        const result = await runShellenv(shellPath);

        expect(result.exitCode).toBe(0);
        expect(result.stdout.startsWith(prefix)).toBe(true);
        expect(result.stderr).toBe('');
    });

    it.each(['bash', 'zsh', 'fish', 'BASH', 'ZSH', 'FISH'])(
        'lets an explicit %s override an unsupported $SHELL',
        async (shell) => {
            const result = await runShellenv('/bin/dash', shell);

            expect(result.exitCode).toBe(0);
            expect(result.stdout.startsWith(shell.toLowerCase() === 'fish' ? 'function wt' : 'wt() {')).toBe(true);
            expect(result.stderr).toBe('');
        },
    );

    it.each(['/bin/sh', '/bin/dash', '/bin/tcsh', '/usr/bin/nu', '/bin/bash-not'])(
        'rejects unsupported auto-detected shell %s without emitting a wrapper',
        async (shellPath) => {
            const result = await runShellenv(shellPath);

            expect(result.exitCode).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain(`Unsupported shell: ${shellPath}`);
            expect(result.stderr).toContain('Supported shells: bash, zsh, fish');
        },
    );

    it.each([undefined, ''])('rejects missing or empty $SHELL (%s)', async (shellPath) => {
        const result = await runShellenv(shellPath);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Could not detect shell: $SHELL is not set');
        expect(result.stderr).toContain('Supported shells: bash, zsh, fish');
    });

    it('rejects an explicit unsupported shell even when $SHELL is supported', async () => {
        const result = await runShellenv('/bin/zsh', 'dash');

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Unsupported shell: dash');
    });

    it.each(['bash', 'zsh', 'fish'])('supports explicit %s when $SHELL is missing', async (shell) => {
        const result = await runShellenv(undefined, shell);

        expect(result.exitCode).toBe(0);
        expect(result.stdout.startsWith(shell === 'fish' ? 'function wt' : 'wt() {')).toBe(true);
        expect(result.stderr).toBe('');
    });
});
